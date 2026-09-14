/**
 * The cut order, kept in step with what it is calculated from.
 *
 * The CUT ledger is a stored snapshot of `(order − stock) × (1 + allowance)`.
 * It is read-only everywhere in the application — no screen lets anyone type a
 * cut quantity — so rewriting it destroys nothing a person entered, and leaving
 * it stale after one of its inputs moves is simply a wrong number on the sheet
 * the cutting floor works from.
 */

import { QtyLedger, computeCutMatrix, type QtyCell } from '@opsflow/shared';
import { prisma } from '../db.js';
import { ORDER_INCLUDE, deriveOrder, type FullOrder } from './order-service.js';

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

/** Recalculate the CUT ledger and store it. Returns the new and previous totals. */
export async function writeCutOrder(order: FullOrder): Promise<{ total: number; before: number }> {
  const d = deriveOrder(order);
  const cutPct = Number(order.cutPercentage.toString());
  const cutCells: QtyCell[] = computeCutMatrix(d.cells, d.colors, d.sizes, cutPct);

  await prisma.$transaction(async (tx) => {
    await tx.stageQuantity.deleteMany({ where: { orderId: order.id, ledger: 'CUT' } });
    if (cutCells.length > 0) {
      await tx.stageQuantity.createMany({
        data: cutCells.map((c) => ({
          orderId: order.id, orderColorId: c.colorId, orderSizeId: c.sizeId, ledger: 'CUT' as const, qty: c.qty,
        })),
      });
    }
  });

  return { total: cutCells.reduce((a, c) => a + c.qty, 0), before: d.totals[QtyLedger.CUT] ?? 0 };
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
  const existing = await prisma.stageQuantity.count({ where: { orderId, ledger: 'CUT' } });
  if (existing === 0) return null;

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  if (!order) return null;

  const { total } = await writeCutOrder(order);
  return total;
}
