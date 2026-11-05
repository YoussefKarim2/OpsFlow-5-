/**
 * Expected costing — what the order should cost, worked out before it is made.
 *
 * The actual costing waits for the floor: fabric issued, pieces passed, days in
 * line. The expected costing asks the same questions of the plan instead — the
 * Main Order quantity, the bill of materials' required quantities and prices,
 * the External Order's prices, the Production step's line plan and target per
 * day, and the factory's daily cost — and runs them through the very same
 * `computeCosting`, so the two can be read side by side without a second
 * formula to disagree with the first.
 *
 * Every figure is filled from the order when the order knows it. A figure the
 * order does not know is typed by hand and stored on the order. A typed figure
 * is only a stand-in: once the order learns the real one (a price arrives on
 * the BOM, a target is set on Production), the order's figure is used.
 */

import { computeCosting, type CostGroup, type CostLineInput } from './costing.js';

/** Where a figure came from: the order, a person, or nowhere yet. */
export type ExpectedSource = 'auto' | 'typed' | null;

export interface ExpectedFigure {
  value: number | null;
  source: ExpectedSource;
}

/** One planned material or outside-work row, as the order holds it. */
export interface ExpectedSourceLine {
  group: CostGroup;
  label: string;
  unit: string;
  /** Stable key of the row (the BOM line / external operation it came from). */
  ref: string;
  /** Planned quantity for the whole order (BOM required qty, outside-work pieces). */
  plannedQty: number | null;
  unitPriceUsd: number | null;
}

/** Keys of figures that can be typed; per-row ones are `qty:<ref>` and `price:<ref>`. */
export const EXPECTED_ORDER_KEYS = [
  'orderQty', 'sellPriceUsd', 'dailyCostUsd', 'machineCount', 'lineMachines', 'targetPerDay', 'otherCostUsd',
] as const;
export type ExpectedOrderKey = (typeof EXPECTED_ORDER_KEYS)[number];

export type ExpectedTyped = Record<string, number>;

export interface ExpectedCostingInput {
  orderQty: number | null;
  sellPriceUsd: number | null;
  dailyCostUsd: number | null;
  machineCount: number | null;
  lineMachines: number | null;
  targetPerDay: number | null;
  lines: readonly ExpectedSourceLine[];
  typed?: ExpectedTyped | null;
}

export interface ExpectedLineResult extends ExpectedSourceLine {
  qty: ExpectedFigure;
  price: ExpectedFigure;
  cost: number | null;
}

export interface ExpectedCostingResult {
  orderQty: ExpectedFigure;
  sellPriceUsd: ExpectedFigure;
  dailyCostUsd: ExpectedFigure;
  machineCount: ExpectedFigure;
  lineMachines: ExpectedFigure;
  targetPerDay: ExpectedFigure;
  /** Typed only: anything else the order will cost, in dollars for the whole order. */
  otherCostUsd: ExpectedFigure;
  /** Working days the line is expected to need: quantity ÷ target per day, rounded up. */
  daysInLine: number | null;
  lines: ExpectedLineResult[];
  fabricCostUsd: number | null;
  accessoryCostUsd: number | null;
  externalCostUsd: number | null;
  cmCostUsd: number | null;
  cmCostPerPieceUsd: number | null;
  otherTotalUsd: number | null;
  totalCostUsd: number | null;
  unitCostUsd: number | null;
  profitPerUnitUsd: number | null;
  profitPct: number | null;
  /** What still has to be typed before the costing is complete, in words. */
  missing: string[];
}

const positive = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n > 0;

/** The order's figure when it has one, else the typed one. */
function resolve(auto: number | null | undefined, typed: number | undefined, allowZero = false): ExpectedFigure {
  const ok = (n: number | null | undefined): n is number =>
    n != null && Number.isFinite(n) && (allowZero ? n >= 0 : n > 0);
  if (ok(auto)) return { value: auto, source: 'auto' };
  if (ok(typed)) return { value: typed, source: 'typed' };
  return { value: null, source: null };
}

/** A typed map with anything that is not a finite, non-negative number dropped. */
export function sanitiseExpectedTyped(raw: unknown): ExpectedTyped {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ExpectedTyped = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.length > 200) continue;
    const known = (EXPECTED_ORDER_KEYS as readonly string[]).includes(k) || /^(qty|price):.+/.test(k);
    if (!known) continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isFinite(n) && n >= 0 && n < 1e12) out[k] = n;
  }
  return out;
}

export function computeExpectedCosting(input: ExpectedCostingInput): ExpectedCostingResult {
  const typed = input.typed ?? {};
  const orderQty = resolve(input.orderQty, typed.orderQty);
  const sellPriceUsd = resolve(input.sellPriceUsd, typed.sellPriceUsd);
  const dailyCostUsd = resolve(input.dailyCostUsd, typed.dailyCostUsd);
  const machineCount = resolve(input.machineCount, typed.machineCount);
  const lineMachines = resolve(input.lineMachines, typed.lineMachines);
  const targetPerDay = resolve(input.targetPerDay, typed.targetPerDay);
  const otherCostUsd = resolve(null, typed.otherCostUsd, true);

  const qty = orderQty.value;
  const daysInLine = positive(qty) && positive(targetPerDay.value) ? Math.ceil(qty / targetPerDay.value) : null;

  const lines: ExpectedLineResult[] = input.lines.map((l) => {
    const q = resolve(l.plannedQty, typed[`qty:${l.ref}`]);
    const p = resolve(l.unitPriceUsd, typed[`price:${l.ref}`], true);
    return { ...l, qty: q, price: p, cost: q.value != null && p.value != null ? q.value * p.value : null };
  });

  const costLines: CostLineInput[] = lines.map((l) => ({
    group: l.group, label: l.label, unit: l.unit, quantity: l.qty.value, unitPriceUsd: l.price.value, sourceRef: l.ref,
  }));
  if (otherCostUsd.value != null) {
    costLines.push({ group: 'OTHER', label: 'Other costs', unit: 'ORDER', quantity: 1, unitPriceUsd: otherCostUsd.value });
  }

  // The actual costing's own engine, given the plan: every planned piece is a
  // shipped, first-degree piece, and the line holds its machines for the days
  // the target says the quantity needs.
  const r = computeCosting({
    orderQty: qty ?? 0,
    cutQty: qty ?? 0,
    shippedQty: qty,
    firstDegreeQty: qty,
    dailyCostUsd: dailyCostUsd.value,
    machineCount: machineCount.value,
    machineDaysUsed: null,
    daysInLine,
    lineMachineQty: lineMachines.value,
    targetPerDay: targetPerDay.value,
    sellPriceUsd: sellPriceUsd.value,
    lines: costLines,
  });

  const missing: string[] = [];
  if (orderQty.value == null) missing.push('the order quantity');
  if (sellPriceUsd.value == null) missing.push('the selling price');
  if (dailyCostUsd.value == null) missing.push("the factory's daily cost");
  if (machineCount.value == null) missing.push("the factory's machine count");
  if (lineMachines.value == null) missing.push('the machines on the line');
  if (targetPerDay.value == null) missing.push('the target per day');
  const noQty = lines.filter((l) => l.qty.value == null).length;
  const noPrice = lines.filter((l) => l.price.value == null).length;
  if (noQty > 0) missing.push(`${noQty} planned quantit${noQty === 1 ? 'y' : 'ies'}`);
  if (noPrice > 0) missing.push(`${noPrice} unit price${noPrice === 1 ? '' : 's'}`);

  return {
    orderQty, sellPriceUsd, dailyCostUsd, machineCount, lineMachines, targetPerDay, otherCostUsd,
    daysInLine,
    lines,
    fabricCostUsd: r.fabricCostUsd,
    accessoryCostUsd: r.accessoryCostUsd,
    externalCostUsd: r.externalCostUsd,
    cmCostUsd: r.cmCostUsd,
    cmCostPerPieceUsd: r.cmCostPerPieceUsd,
    otherTotalUsd: r.otherCostUsd,
    totalCostUsd: r.totalCostUsd,
    unitCostUsd: r.unitActualCostUsd,
    profitPerUnitUsd: r.profitPerUnitUsd,
    profitPct: r.profitPct,
    missing,
  };
}
