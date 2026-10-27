/**
 * The cut order, kept in step with what it is calculated from.
 *
 * The CUT ledger is a stored snapshot of `(order − stock) × (1 + allowance)`.
 * It is read-only everywhere in the application — no screen lets anyone type a
 * cut quantity — so rewriting it destroys nothing a person entered, and leaving
 * it stale after one of its inputs moves is simply a wrong number on the sheet
 * the cutting floor works from.
 */

import { QtyLedger, computeCutMatrix, ledgerTotal, type QtyCell } from '@opsflow/shared';
import { prisma } from '../db.js';
import { ORDER_INCLUDE, toAxes, toQtyCells } from './order-service.js';

/**
 * The ledgers the cut order is calculated from. Writing any of these leaves a
 * stored cut order out of date.
 *
 * CUT itself is deliberately absent: it is the output, and refreshing it in
 * response to its own write would be a rewrite chasing a rewrite. So are the
 * ledgers downstream of cutting — sewing and packing consume cut pieces, they
 * do not change how many should have been cut.
 */
export const CUT_ORDER_INPUT_LEDGERS: readonly string[] = [QtyLedger.ORDER, QtyLedger.STOCK];

/**
 * Recalculate the CUT ledger and store it. Returns the new and previous totals.
 *
 * Calculated inside the transaction that writes it, under the order's row
 * lock, from the quantities as they are at that moment. Working from the copy
 * the caller had read earlier left a window in which a grid save landing
 * between the read and the write was cut from the old figures — and two saves
 * at once could each rewrite the sheet from a different half of the truth.
 * The lock is the one `POST /orders/:id/sizes` and the matrix save take, so
 * all three queue behind one another.
 */
export async function writeCutOrder(order: { id: string }): Promise<{ total: number; before: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
    const fresh = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      select: {
        cutPercentage: true,
        updatedAt: true,
        colors: ORDER_INCLUDE.colors,
        sizes: ORDER_INCLUDE.sizes,
        quantities: true,
      },
    });
    const cells = toQtyCells(fresh);
    const { colors, sizes } = toAxes(fresh);
    const cutCells: QtyCell[] = computeCutMatrix(cells, colors, sizes, Number(fresh.cutPercentage.toString()));
    const before = ledgerTotal(cells, QtyLedger.CUT);

    // Recorded separately from the rows: when stock covers every cell the
    // cut order is empty, and "generated, nothing to cut" must stay
    // distinguishable from "never generated" — see `shouldRefreshCutOrder`.
    // The order's `updatedAt` is written back as it was: recalculating the cut
    // order is not an edit of the order's details, and the details save is
    // checked against that column. Safe under the row lock — nothing else can
    // have moved it since it was read.
    await tx.order.update({
      where: { id: order.id },
      data: { cutOrderGeneratedAt: new Date(), updatedAt: fresh.updatedAt },
    });
    await tx.stageQuantity.deleteMany({ where: { orderId: order.id, ledger: 'CUT' } });
    if (cutCells.length > 0) {
      await tx.stageQuantity.createMany({
        data: cutCells.map((c) => ({
          orderId: order.id, orderColorId: c.colorId, orderSizeId: c.sizeId, ledger: 'CUT' as const, qty: c.qty,
        })),
      });
    }
    return { total: cutCells.reduce((a, c) => a + c.qty, 0), before };
  });
}

/**
 * Refresh a cut order that already exists, after one of its inputs moved.
 *
 * Only touches an order that has a cut order already. Generating one the first
 * time is a deliberate act — the Cut Order step has a button for it — and
 * conjuring one because somebody recorded stock would make that step look
 * finished before anyone had been near it. Returns null when there was nothing
 * to refresh.
 */
export async function refreshCutOrder(orderId: string): Promise<number | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  if (!order) return null;
  const cutRowCount = order.quantities.filter((q) => q.ledger === 'CUT').length;
  if (!shouldRefreshCutOrder({ generatedAt: order.cutOrderGeneratedAt, cutRowCount })) return null;

  const { total } = await writeCutOrder(order);
  return total;
}

/**
 * Whether an order has a cut order to keep up to date.
 *
 * Counting CUT rows alone used to decide it, and failed exactly when stock
 * covered every cell: the rewrite left no rows, and from then on the order
 * looked as if no cut order had ever been generated — so taking the stock
 * back out never put the pieces back on the sheet. The generation time is
 * what answers it now. Rows without one still count: a cut matrix read in by
 * the order importer, or written before the time was recorded, is a cut order
 * all the same.
 */
export function shouldRefreshCutOrder(state: { generatedAt: Date | null; cutRowCount: number }): boolean {
  return state.generatedAt != null || state.cutRowCount > 0;
}
