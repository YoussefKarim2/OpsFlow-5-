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
 * Every figure is filled from the order when the order knows it, and every
 * figure — the order's and the calculated ones alike (days in line, C.M,
 * subtotals, the total, the profit) — can be typed over, as on the actual
 * costing. A typed figure wins and is stored on the order; the figure it
 * replaced is kept beside it (`base`) so it can be shown and put back.
 */

import { computeCosting, type CostGroup, type CostLineInput } from './costing.js';

/** Where a figure came from: the order, a person, the calculation, or nowhere yet. */
export type ExpectedSource = 'auto' | 'typed' | 'calc' | null;

export interface ExpectedFigure {
  value: number | null;
  source: ExpectedSource;
  /** The order's own (or the calculated) figure — what a typed one replaced. */
  base: number | null;
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
  // Calculated figures, typed over.
  'machineCostPerDay', 'daysInLine', 'cmPerPieceUsd',
  'fabricCostUsd', 'accessoryCostUsd', 'externalCostUsd',
  'totalCostUsd', 'unitCostUsd', 'profitPerUnitUsd', 'profitPct',
] as const;
export type ExpectedOrderKey = (typeof EXPECTED_ORDER_KEYS)[number];

/** Figures that may be typed below zero: a planned loss is a loss. */
export const EXPECTED_SIGNED_KEYS: readonly string[] = ['profitPerUnitUsd', 'profitPct'];

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
  /** Working days the line is expected to need: quantity ÷ target per day, rounded up, or typed. */
  daysInLine: number | null;
  /** The calculated figures, each with what was calculated and whether it was typed over. */
  derived: Record<
    'machineCostPerDay' | 'daysInLine' | 'cmPerPieceUsd' | 'fabricCostUsd' | 'accessoryCostUsd' | 'externalCostUsd'
    | 'totalCostUsd' | 'unitCostUsd' | 'profitPerUnitUsd' | 'profitPct',
    ExpectedFigure
  >;
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

/** The typed figure when there is one, else the order's. */
function resolve(auto: number | null | undefined, typed: number | undefined, allowZero = false): ExpectedFigure {
  const ok = (n: number | null | undefined): n is number =>
    n != null && Number.isFinite(n) && (allowZero ? n >= 0 : n > 0);
  const base = ok(auto) ? auto : null;
  if (ok(typed)) return { value: typed, source: 'typed', base };
  if (base != null) return { value: base, source: 'auto', base };
  return { value: null, source: null, base: null };
}

/** A calculated figure, or the one typed over it. */
function derivedFigure(calculated: number | null | undefined, typed: number | null | undefined): ExpectedFigure {
  const base = calculated ?? null;
  if (typed != null && Number.isFinite(typed)) return { value: typed, source: 'typed', base };
  return { value: base, source: base == null ? null : 'calc', base };
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
    const floor = EXPECTED_SIGNED_KEYS.includes(k) ? -1e12 : 0;
    if (Number.isFinite(n) && n >= floor && n < 1e12) out[k] = n;
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
  const typedOver = (key: string, allowZero = true): number | null => {
    const v = typed[key];
    if (v == null || !Number.isFinite(v)) return null;
    if (EXPECTED_SIGNED_KEYS.includes(key)) return v;
    return allowZero ? (v >= 0 ? v : null) : (v > 0 ? v : null);
  };
  const daysCalc = positive(qty) && positive(targetPerDay.value) ? Math.ceil(qty / targetPerDay.value) : null;
  const daysTyped = typedOver('daysInLine', false);
  const daysInLine = daysTyped ?? daysCalc;

  const lines: ExpectedLineResult[] = input.lines.map((l) => {
    const q = resolve(l.plannedQty, typed[`qty:${l.ref}`]);
    const p = resolve(l.unitPriceUsd, typed[`price:${l.ref}`], true);
    return { ...l, qty: q, price: p, cost: q.value != null && p.value != null ? q.value * p.value : null };
  });

  // Outside work typed as one figure replaces its rows, as a typed figure
  // does on the actual costing.
  const externalTyped = typedOver('externalCostUsd');
  const externalRows = lines.filter((l) => l.group === 'EXTERNAL');
  const externalCalc = externalRows.length === 0 || externalRows.every((l) => l.cost == null)
    ? null : externalRows.reduce((a, l) => a + (l.cost ?? 0), 0);
  const costLines: CostLineInput[] = lines
    .filter((l) => externalTyped == null || l.group !== 'EXTERNAL')
    .map((l) => ({
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
    externalOpCostUsd: externalTyped,
    overrides: {
      machineCostPerDay: typedOver('machineCostPerDay'),
      cmCostUsd: (() => {
        const perPc = typedOver('cmPerPieceUsd');
        return perPc != null && positive(qty) ? perPc * qty : null;
      })(),
      fabricCostUsd: typedOver('fabricCostUsd'),
      accessoryCostUsd: typedOver('accessoryCostUsd'),
      totalCostUsd: typedOver('totalCostUsd'),
      unitActualCostUsd: typedOver('unitCostUsd'),
      profitPerUnitUsd: typedOver('profitPerUnitUsd'),
      profitPct: typedOver('profitPct'),
    },
  });
  /** What the engine worked out for a cell, whether or not it was typed over. */
  const calc = (key: keyof typeof r.calculated, value: number | null): number | null =>
    r.overridden.includes(key) ? (r.calculated[key] as number | null) ?? null : value;
  const cmCalc = calc('cmCostUsd', r.cmCostUsd);
  const derived: ExpectedCostingResult['derived'] = {
    machineCostPerDay: derivedFigure(calc('machineCostPerDay', r.machineCostPerDay), typedOver('machineCostPerDay')),
    daysInLine: derivedFigure(daysCalc, daysTyped),
    cmPerPieceUsd: derivedFigure(cmCalc != null && positive(qty) ? cmCalc / qty : null, positive(qty) ? typedOver('cmPerPieceUsd') : null),
    fabricCostUsd: derivedFigure(calc('fabricCostUsd', r.fabricCostUsd), typedOver('fabricCostUsd')),
    accessoryCostUsd: derivedFigure(calc('accessoryCostUsd', r.accessoryCostUsd), typedOver('accessoryCostUsd')),
    externalCostUsd: derivedFigure(externalCalc, externalTyped),
    totalCostUsd: derivedFigure(calc('totalCostUsd', r.totalCostUsd), typedOver('totalCostUsd')),
    unitCostUsd: derivedFigure(calc('unitActualCostUsd', r.unitActualCostUsd), typedOver('unitCostUsd')),
    profitPerUnitUsd: derivedFigure(calc('profitPerUnitUsd', r.profitPerUnitUsd), typedOver('profitPerUnitUsd')),
    profitPct: derivedFigure(calc('profitPct', r.profitPct), typedOver('profitPct')),
  };

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
    derived,
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
