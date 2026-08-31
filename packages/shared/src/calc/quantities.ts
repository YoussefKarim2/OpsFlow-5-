/**
 * The quantity matrix engine.
 *
 * Replaces sheets: Main Order, Cut Order, Stock_Packing, Follow up (9 matrices),
 * and every SUM()/ROUNDUP() in them.
 *
 * The workbook keeps nine separate colour × size grids side by side across 146
 * columns and computes shortages as a third grid subtracting two others. Here
 * there is ONE list of `(color, size, ledger, qty)` cells and shortages are
 * derived on read. A stored shortage is a shortage that can disagree with its
 * inputs; a derived one cannot.
 */

import { QtyLedger, LEDGER_FUNNEL } from '../enums.js';
import { safeDiv, safePct, roundUp, sum } from './num.js';

export interface QtyCell {
  colorId: string;
  sizeId: string;
  ledger: QtyLedger;
  qty: number;
}

export interface AxisRef {
  id: string;
  name: string;
  /** Display order — sizes must render 2YXS → 3XL, not alphabetically. */
  position: number;
}

/** A rendered matrix: rows are colours, columns are sizes, plus every total. */
export interface QuantityMatrix {
  ledger: QtyLedger;
  colors: AxisRef[];
  sizes: AxisRef[];
  /** cells[colorId][sizeId] — absent means zero. */
  cells: Record<string, Record<string, number>>;
  rowTotals: Record<string, number>;
  colTotals: Record<string, number>;
  grandTotal: number;
}

const emptyRow = (sizes: AxisRef[]): Record<string, number> =>
  Object.fromEntries(sizes.map((s) => [s.id, 0]));

/**
 * Build one matrix for one ledger. Equivalent to an entire Excel sheet block
 * including its SUM row and SUM column.
 */
export function buildMatrix(
  cells: readonly QtyCell[],
  colors: AxisRef[],
  sizes: AxisRef[],
  ledger: QtyLedger,
): QuantityMatrix {
  const sortedColors = [...colors].sort((a, b) => a.position - b.position);
  const sortedSizes = [...sizes].sort((a, b) => a.position - b.position);

  const grid: Record<string, Record<string, number>> = {};
  for (const c of sortedColors) grid[c.id] = emptyRow(sortedSizes);

  for (const cell of cells) {
    if (cell.ledger !== ledger) continue;
    const row = grid[cell.colorId];
    if (!row || !(cell.sizeId in row)) continue; // cell for an axis this order no longer has
    row[cell.sizeId] = (row[cell.sizeId] ?? 0) + cell.qty;
  }

  const rowTotals: Record<string, number> = {};
  const colTotals: Record<string, number> = Object.fromEntries(sortedSizes.map((s) => [s.id, 0]));
  let grandTotal = 0;

  for (const c of sortedColors) {
    let rowSum = 0;
    for (const s of sortedSizes) {
      const v = grid[c.id]?.[s.id] ?? 0;
      rowSum += v;
      colTotals[s.id] = (colTotals[s.id] ?? 0) + v;
    }
    rowTotals[c.id] = rowSum;
    grandTotal += rowSum;
  }

  return { ledger, colors: sortedColors, sizes: sortedSizes, cells: grid, rowTotals, colTotals, grandTotal };
}

/** Grand total for one ledger without materialising the whole grid. */
export function ledgerTotal(cells: readonly QtyCell[], ledger: QtyLedger): number {
  return sum(cells.filter((c) => c.ledger === ledger).map((c) => c.qty));
}

export function ledgerTotals(cells: readonly QtyCell[]): Record<QtyLedger, number> {
  const out = {} as Record<QtyLedger, number>;
  for (const l of Object.values(QtyLedger)) out[l] = 0;
  for (const c of cells) out[c.ledger] = (out[c.ledger] ?? 0) + c.qty;
  return out;
}

/**
 * Cut Order sheet, cell-for-cell.
 *
 * Excel: `=IFERROR(IF((MainOrder - Stock) <= 0, "", ROUNDUP((MainOrder - Stock) * (1 + cutPct), 0)), "")`
 *
 * Verified against the live file at cutPct = 0.05:
 *   20 → 21 · 50 → 53 · 138 → 145 · 141 → 149 · 90 → 95 · 70 → 74 · 35 → 37
 * Grand total 1,972 ordered → 2,084 to cut.
 */
export function computeCutQty(orderQty: number, stockQty: number, cutPct: number): number {
  const net = orderQty - stockQty;
  if (net <= 0) return 0;
  return roundUp(net * (1 + cutPct));
}

/** Apply the cut formula across the whole matrix, producing CUT ledger cells. */
export function computeCutMatrix(
  cells: readonly QtyCell[],
  colors: AxisRef[],
  sizes: AxisRef[],
  cutPct: number,
): QtyCell[] {
  const order = buildMatrix(cells, colors, sizes, QtyLedger.ORDER);
  const stock = buildMatrix(cells, colors, sizes, QtyLedger.STOCK);
  const out: QtyCell[] = [];
  for (const c of order.colors) {
    for (const s of order.sizes) {
      const qty = computeCutQty(order.cells[c.id]?.[s.id] ?? 0, stock.cells[c.id]?.[s.id] ?? 0, cutPct);
      if (qty > 0) out.push({ colorId: c.id, sizeId: s.id, ledger: QtyLedger.CUT, qty });
    }
  }
  return out;
}

/**
 * Stock deduction summary — the brief's section 17.
 * "Customer order 2000, existing stock 200, required production 1800."
 */
export interface StockDeduction {
  customerOrderQty: number;
  usableStockQty: number;
  requiredProductionQty: number;
  cutQtyWithAllowance: number;
  cutAllowancePct: number;
}

export function computeStockDeduction(cells: readonly QtyCell[], cutPct: number): StockDeduction {
  const customerOrderQty = ledgerTotal(cells, QtyLedger.ORDER);
  const usableStockQty = ledgerTotal(cells, QtyLedger.STOCK);
  const requiredProductionQty = Math.max(0, customerOrderQty - usableStockQty);
  const cutQtyWithAllowance = ledgerTotal(cells, QtyLedger.CUT);
  return { customerOrderQty, usableStockQty, requiredProductionQty, cutQtyWithAllowance, cutAllowancePct: cutPct * 100 };
}

/**
 * The Follow-up sheet's shortage blocks, derived.
 * Excel keeps three of these as stored grids; all three are subtractions.
 */
export interface LedgerVariance {
  from: QtyLedger;
  to: QtyLedger;
  label: string;
  fromQty: number;
  toQty: number;
  /** to − from. Negative = loss through the stage. */
  variance: number;
  yieldPct: number | null;
}

export function computeVariances(cells: readonly QtyCell[]): LedgerVariance[] {
  const t = ledgerTotals(cells);
  const pairs: Array<[QtyLedger, QtyLedger, string]> = [
    [QtyLedger.CUT, QtyLedger.IN_LINE, 'Cut → In-line'],
    [QtyLedger.IN_LINE, QtyLedger.OUT_LINE, 'In-line → Out-line'],
    [QtyLedger.OUT_LINE, QtyLedger.PACKED, 'Out-line → Packed'],
    [QtyLedger.ORDER, QtyLedger.PACKED, 'Ordered → Packed'],
    [QtyLedger.PACKED, QtyLedger.SHIPPED, 'Packed → Shipped'],
  ];
  return pairs.map(([from, to, label]) => {
    const fromQty = t[from] ?? 0;
    const toQty = t[to] ?? 0;
    return { from, to, label, fromQty, toQty, variance: toQty - fromQty, yieldPct: safePct(toQty, fromQty) };
  });
}

/** Cut variance against plan — the brief's section 11 (+14 style readout). */
export interface CutVariance {
  orderedQty: number;
  plannedCutQty: number;
  actualCutQty: number;
  /** actual − planned */
  variance: number;
  variancePct: number | null;
}

export function computeCutVariance(cells: readonly QtyCell[], cutPct: number, actualCutQty: number | null): CutVariance {
  const orderedQty = ledgerTotal(cells, QtyLedger.ORDER);
  const stockQty = ledgerTotal(cells, QtyLedger.STOCK);
  const plannedCutQty = roundUp(Math.max(0, orderedQty - stockQty) * (1 + cutPct));
  const actual = actualCutQty ?? ledgerTotal(cells, QtyLedger.CUT);
  return {
    orderedQty,
    plannedCutQty,
    actualCutQty: actual,
    variance: actual - plannedCutQty,
    variancePct: safePct(actual - plannedCutQty, plannedCutQty),
  };
}

/** Funnel for the Overview tab: ordered → cut → produced → passed → packed → shipped. */
export interface FunnelStep {
  ledger: QtyLedger;
  qty: number;
  /** Percentage of the ORDER ledger. */
  pctOfOrder: number | null;
  /** Percentage of the previous step. */
  pctOfPrev: number | null;
}

export function computeFunnel(cells: readonly QtyCell[]): FunnelStep[] {
  const t = ledgerTotals(cells);
  const base = t[QtyLedger.ORDER] ?? 0;
  let prev: number | null = null;
  return LEDGER_FUNNEL.map((ledger) => {
    const qty = t[ledger] ?? 0;
    const step: FunnelStep = { ledger, qty, pctOfOrder: safePct(qty, base), pctOfPrev: prev === null ? 100 : safePct(qty, prev) };
    prev = qty;
    return step;
  });
}

/** Per-colour progress, so a coordinator can see that Lime is behind while Scarlet is fine. */
export interface ColorProgress {
  colorId: string;
  colorName: string;
  ordered: number;
  cut: number;
  produced: number;
  packed: number;
  completionPct: number | null;
}

export function computeColorProgress(cells: readonly QtyCell[], colors: AxisRef[]): ColorProgress[] {
  return [...colors]
    .sort((a, b) => a.position - b.position)
    .map((c) => {
      const forColor = cells.filter((x) => x.colorId === c.id);
      const t = ledgerTotals(forColor);
      const ordered = t[QtyLedger.ORDER] ?? 0;
      return {
        colorId: c.id,
        colorName: c.name,
        ordered,
        cut: t[QtyLedger.CUT] ?? 0,
        produced: t[QtyLedger.IN_LINE] ?? 0,
        packed: t[QtyLedger.PACKED] ?? 0,
        completionPct: safePct(t[QtyLedger.PACKED] ?? 0, ordered),
      };
    });
}

/** Quality pass rate across the whole order. */
export function computeQualityPassPct(cells: readonly QtyCell[]): number | null {
  const t = ledgerTotals(cells);
  const inspected = t[QtyLedger.IN_LINE] ?? 0;
  const passed = t[QtyLedger.OUT_LINE] ?? 0;
  return safePct(passed, inspected);
}

/** Per-piece consumption × quantity, used by BOM required-qty derivation. */
export function requiredFromConsumption(consumptionPerPiece: number, qty: number): number | null {
  const r = consumptionPerPiece * qty;
  return Number.isFinite(r) ? r : null;
}

export { safeDiv };
