/**
 * Finished stock is recorded in two places, and they have to be the same fact.
 *
 * The Stock step keeps `stock_records` — one row per colour and size, with a
 * location and a note, which is how a storeman thinks about it. The Quantity
 * tab keeps the STOCK ledger — a cell in the colour × size matrix, which is
 * how the arithmetic thinks about it. The cut order is calculated from the
 * ledger.
 *
 * Nothing used to connect them, so recording finished stock in the Stock step
 * wrote a row the cut order never read, and the subtraction the step promises
 * on screen never happened. This module is that connection, in both
 * directions, so neither screen can be right while the other is wrong.
 */

import { prisma } from '../db.js';
import { refreshCutOrder } from './cut-order.js';

/**
 * Colour and size are typed as text in the Stock step and held as references
 * everywhere else, so they are matched by name. "sky blue", "SKY BLUE" and
 * "Sky  Blue" are one colour; anything else would make the match depend on how
 * carefully somebody typed.
 */
export function normaliseAxisName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase();
}

export interface AxisOption {
  /** The OrderColor / OrderSize row id — what the ledger is keyed by. */
  id: string;
  /** The reference name shown in the app. */
  name: string;
  /** Sizes also carry a long form ("YOUTH 2X-SMALL"); either spelling matches. */
  longName?: string | null;
}

/** The axis entry a typed name refers to, or null when it names nothing on this order. */
export function matchAxis(typed: string, options: readonly AxisOption[]): AxisOption | null {
  const wanted = normaliseAxisName(typed);
  if (wanted === '') return null;
  return options.find((o) =>
    normaliseAxisName(o.name) === wanted
    || (o.longName != null && normaliseAxisName(o.longName) === wanted),
  ) ?? null;
}

interface OrderAxes {
  colors: AxisOption[];
  sizes: AxisOption[];
}

async function loadAxes(orderId: string): Promise<OrderAxes> {
  const [colors, sizes] = await Promise.all([
    prisma.orderColor.findMany({
      where: { orderId }, include: { color: true }, orderBy: { position: 'asc' },
    }),
    prisma.orderSize.findMany({
      where: { orderId }, include: { size: true }, orderBy: { position: 'asc' },
    }),
  ]);
  return {
    colors: colors.map((c) => ({ id: c.id, name: c.color.name })),
    sizes: sizes.map((s) => ({ id: s.id, name: s.size.name, longName: s.size.longName })),
  };
}

/** What the order's colour and size axes are called, for error messages and the UI. */
export async function orderAxisNames(orderId: string): Promise<{ colors: string[]; sizes: string[] }> {
  const axes = await loadAxes(orderId);
  return { colors: axes.colors.map((c) => c.name), sizes: axes.sizes.map((s) => s.name) };
}

/**
 * Whether a colour and size typed into the Stock step name a cell of this
 * order's matrix. A row that names nothing can never be subtracted from
 * anything, so the caller refuses it rather than storing a number that will
 * quietly do nothing.
 */
export async function resolveStockCell(
  orderId: string, colorName: string, sizeName: string,
): Promise<{ orderColorId: string; orderSizeId: string } | null> {
  const axes = await loadAxes(orderId);
  const color = matchAxis(colorName, axes.colors);
  const size = matchAxis(sizeName, axes.sizes);
  if (!color || !size) return null;
  return { orderColorId: color.id, orderSizeId: size.id };
}

/**
 * Write the Stock step's rows into the STOCK ledger, so the cut order sees
 * them. The rows are the source of truth: a cell whose row was deleted goes
 * back to zero, which is what "the stock is no longer there" has to mean.
 *
 * Rows naming a colour or size that is not on the order are left out — they
 * cannot be placed in the matrix — and reported back so the caller can say so.
 */
export async function applyStockRecordsToLedger(
  orderId: string,
): Promise<{ applied: number; total: number; unmatched: string[]; changed: boolean }> {
  const [records, axes] = await Promise.all([
    prisma.stockRecord.findMany({ where: { orderId } }),
    loadAxes(orderId),
  ]);

  const wanted = new Map<string, number>();
  const unmatched: string[] = [];
  for (const r of records) {
    const color = matchAxis(r.colorName, axes.colors);
    const size = matchAxis(r.sizeName, axes.sizes);
    if (!color || !size) {
      unmatched.push(`${r.colorName} / ${r.sizeName}`);
      continue;
    }
    const key = `${color.id}:${size.id}`;
    // Two rows can normalise onto one cell ("Sky Blue" and "SKY BLUE"). They
    // are both stock, so they add up rather than one winning.
    wanted.set(key, (wanted.get(key) ?? 0) + r.availableQty);
  }

  const existing = await prisma.stageQuantity.findMany({
    where: { orderId, ledger: 'STOCK' },
    select: { id: true, orderColorId: true, orderSizeId: true, qty: true },
  });
  const existingByCell = new Map(existing.map((e) => [`${e.orderColorId}:${e.orderSizeId}`, e]));
  const moved = [...wanted].filter(([key, qty]) => existingByCell.get(key)?.qty !== qty);
  // A cell the step no longer records is not stock any more.
  const stale = existing.filter((e) => !wanted.has(`${e.orderColorId}:${e.orderSizeId}`) && e.qty !== 0);
  const changed = moved.length > 0 || stale.length > 0;

  if (changed) {
    await prisma.$transaction(async (tx) => {
      for (const [key, qty] of moved) {
        const [orderColorId, orderSizeId] = key.split(':');
        await tx.stageQuantity.upsert({
          where: {
            orderId_orderColorId_orderSizeId_ledger: { orderId, orderColorId, orderSizeId, ledger: 'STOCK' },
          },
          create: { orderId, orderColorId, orderSizeId, ledger: 'STOCK', qty },
          update: { qty },
        });
      }
      if (stale.length > 0) {
        await tx.stageQuantity.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { qty: 0 } });
      }
    });
  }

  return {
    applied: wanted.size,
    total: [...wanted.values()].reduce((a, q) => a + q, 0),
    unmatched,
    changed,
  };
}

/**
 * The other direction: STOCK typed straight into the Quantity tab's grid is
 * written back as Stock step rows, so the two screens show one number.
 *
 * Rows naming something that is not on the order are left alone — they were
 * typed by a person about this order and are not this function's to delete.
 */
export async function applyLedgerToStockRecords(orderId: string): Promise<number> {
  const [cells, axes, records] = await Promise.all([
    prisma.stageQuantity.findMany({
      where: { orderId, ledger: 'STOCK' },
      select: { orderColorId: true, orderSizeId: true, qty: true },
    }),
    loadAxes(orderId),
    prisma.stockRecord.findMany({ where: { orderId } }),
  ]);

  const colorName = new Map(axes.colors.map((c) => [c.id, c.name]));
  const sizeName = new Map(axes.sizes.map((s) => [s.id, s.name]));
  const rowFor = new Map<string, typeof records[number]>();
  for (const r of records) {
    const color = matchAxis(r.colorName, axes.colors);
    const size = matchAxis(r.sizeName, axes.sizes);
    if (color && size) rowFor.set(`${color.id}:${size.id}`, r);
  }

  let written = 0;
  for (const cell of cells) {
    const cName = colorName.get(cell.orderColorId);
    const sName = sizeName.get(cell.orderSizeId);
    if (!cName || !sName) continue;
    const row = rowFor.get(`${cell.orderColorId}:${cell.orderSizeId}`);

    if (cell.qty > 0) {
      if (row) {
        if (row.availableQty !== cell.qty) {
          await prisma.stockRecord.update({
            where: { id: row.id }, data: { availableQty: cell.qty, recordedAt: new Date() },
          });
          written += 1;
        }
      } else {
        await prisma.stockRecord.create({
          data: {
            orderId, colorName: cName, sizeName: sName, availableQty: cell.qty,
            notes: 'Entered on the Quantity tab',
          },
        });
        written += 1;
      }
    } else if (row) {
      // The grid says there is none. The step's row said there was.
      await prisma.stockRecord.delete({ where: { id: row.id } });
      written += 1;
    }
  }
  return written;
}

/**
 * Bring every order's STOCK ledger into line with its Stock step rows.
 *
 * Stock recorded before the two were connected sits in `stock_records` having
 * never reached the ledger, so those orders still show a cut order that
 * ignores it. This is run once at start-up to settle them; on a database that
 * already agrees it writes nothing and costs one query per order that has any
 * stock at all.
 */
export async function reconcileAllStockLedgers(): Promise<{ scanned: number; corrected: number }> {
  const withStock = await prisma.stockRecord.findMany({
    distinct: ['orderId'], select: { orderId: true },
  });

  let corrected = 0;
  for (const { orderId } of withStock) {
    try {
      const { changed, unmatched } = await applyStockRecordsToLedger(orderId);
      if (unmatched.length > 0) {
        // Recorded against a colour or size the order does not have, so it can
        // never come off the cut order. New rows like this are refused; these
        // predate that, and saying so beats leaving them invisible.
        console.warn(`[stock] order ${orderId}: ${unmatched.join('; ')} match no cell of this order`);
      }
      if (!changed) continue;
      corrected += 1;
      await refreshCutOrder(orderId);
    } catch (err) {
      // One unreconcilable order must not stop the rest, and must not stop the
      // server coming up.
      console.error(`[stock] could not reconcile order ${orderId}:`, (err as Error).message);
    }
  }
  return { scanned: withStock.length, corrected };
}
