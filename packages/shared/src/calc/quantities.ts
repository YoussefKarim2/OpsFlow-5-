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
import { safeDiv, safePct, sum } from './num.js';

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
 * Floating-point slack for the whole-piece rounding rule below.
 *
 * `1000 * 1.1` is `1100.0000000000002` in IEEE-754, and a naive `Math.ceil`
 * would turn a clean 10% allowance on 1,000 pieces into 1,101. Nudging by a
 * millionth before rounding removes that artefact without affecting any real
 * fractional piece, which is never smaller than 0.01.
 */
const PIECE_EPSILON = 1e-6;

/**
 * Cut Order total — the headline figure.
 *
 * ROUNDING RULE (the single rule for the whole Cut Order):
 * the allowance is applied to the Main Order total and rounded UP once, at the
 * total. Pieces are whole, and a factory must never cut fewer than the
 * allowance asks for, so the rounding always goes up.
 *
 *     cutOrderQty = ROUNDUP(mainOrderQty × (1 + cutPct))
 *     1,972 × 1.05 = 2,070.6 → 2,071
 *     1,000 × 1.00 = 1,000.0 → 1,000
 *     1,000 × 1.10 = 1,100.0 → 1,100
 *
 * The size/colour breakdown is then apportioned to sum to exactly this number
 * (see `computeCutMatrix`), so the header and the grid can never disagree.
 *
 * Note this is the ORDER quantity, not order-minus-stock: the Cut Order states
 * how many pieces to cut against the customer's original quantity.
 */
export function computeCutOrderTotal(mainOrderQty: number, cutPct: number): number {
  if (!Number.isFinite(mainOrderQty) || mainOrderQty <= 0) return 0;
  return Math.ceil(mainOrderQty * (1 + cutPct) - PIECE_EPSILON);
}

/**
 * Apply the cut allowance across the whole matrix, producing CUT ledger cells.
 *
 * Rounding up every cell independently would overshoot the headline total —
 * on the reference order, forty cells each gaining most of a piece adds 13 —
 * and the grid would then contradict the number printed above it. So each cell
 * takes its exact share, the fractions are floored, and the pieces left over
 * are handed to the largest fractions first (largest-remainder apportionment).
 *
 * Every cell lands within one piece of its exact share, the column sums to the
 * headline total by construction, and the result is deterministic: ties break
 * on colour then size position, never on object key order.
 */
export function computeCutMatrix(
  cells: readonly QtyCell[],
  colors: AxisRef[],
  sizes: AxisRef[],
  cutPct: number,
): QtyCell[] {
  const order = buildMatrix(cells, colors, sizes, QtyLedger.ORDER);
  const target = computeCutOrderTotal(order.grandTotal, cutPct);
  if (target <= 0) return [];

  interface Share { colorId: string; sizeId: string; base: number; remainder: number; rank: number }
  const shares: Share[] = [];
  let allocated = 0;

  order.colors.forEach((c, ci) => {
    order.sizes.forEach((s, si) => {
      const orderQty = order.cells[c.id]?.[s.id] ?? 0;
      if (orderQty <= 0) return;
      const exact = orderQty * (1 + cutPct);
      const base = Math.floor(exact + PIECE_EPSILON);
      allocated += base;
      shares.push({
        colorId: c.id, sizeId: s.id,
        base, remainder: exact - base,
        rank: ci * order.sizes.length + si,
      });
    });
  });

  // Flooring can only ever land at or below the target, so this is never negative.
  let leftover = target - allocated;
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder || a.rank - b.rank);
  for (const share of byRemainder) {
    if (leftover <= 0) break;
    share.base += 1;
    leftover -= 1;
  }

  return shares
    .filter((share) => share.base > 0)
    .map((share) => ({
      colorId: share.colorId, sizeId: share.sizeId,
      ledger: QtyLedger.CUT, qty: share.base,
    }));
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
  const plannedCutQty = computeCutOrderTotal(orderedQty, cutPct);
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
