/**
 * Actual costing — the brief's section 25.
 *
 * Ports `Actual Costing_Coordinator` including its EGP→USD conversion pattern
 * (`=0.4/$D$12` at a 48.5 dollar rate) and its CM formula
 * (`=D17*D13` — work days × daily cost).
 *
 * The live sheet shows `#DIV/0!` in five cells today because shipped qty is
 * still blank. Every one of those divisions goes through `safeDiv` here, so the
 * same state renders as "Not calculated" instead.
 */

import { safeDiv, safePct, sum } from './num.js';

export interface CostLineInput {
  /** 'FABRIC' | 'ACCESSORY' | 'EXTERNAL' | 'LABOUR' | 'OTHER' */
  group: CostGroup;
  label: string;
  /** Actual consumption. Null when not yet recorded. */
  quantity: number | null;
  unit: string;
  /** Unit price in USD. Accessory prices in the sheet are EGP/dollarRate. */
  unitPriceUsd: number | null;
}

export type CostGroup = 'FABRIC' | 'ACCESSORY' | 'EXTERNAL' | 'LABOUR' | 'OTHER';

export interface CostLineResult extends CostLineInput {
  /** quantity × unitPriceUsd, or null if either is missing. */
  cost: number | null;
  /** Share of the total order cost. */
  pctOfTotal: number | null;
}

export interface CostingInput {
  orderQty: number;
  cutQty: number;
  shippedQty: number | null;
  /** EGP per USD. 48.5 in the source workbook. */
  dollarRate: number;
  /** Factory daily running cost in EGP. 1867 in the source workbook. */
  dailyCostEgp: number | null;
  /** Total machines on the floor. 38 in the source workbook. */
  machineCount: number | null;
  /** Machine-days actually consumed by this order. 130 in the source workbook. */
  machineDaysUsed: number | null;
  /** Calendar days the order occupied a line. 11 in the source workbook. */
  daysInLine: number | null;
  /** Selling price per piece in USD. 7.25 for this order. */
  sellPriceUsd: number | null;
  lines: readonly CostLineInput[];
  externalOpCostUsd?: number | null;
  sublimationCostUsd?: number | null;
  embroideryCostUsd?: number | null;
}

export interface CostingResult {
  // Volumes
  orderQty: number;
  cutQty: number;
  shippedQty: number | null;
  /** cutQty − shippedQty. The sheet's "2nd Degree Qty" column, `=J12-L12`. */
  secondDegreeQty: number | null;
  /** `=(L11/J11)-100%` in the sheet — shipped vs ordered variance. */
  shippedVsOrderedPct: number | null;

  // Machine economics — `=D13/D14` and `=D22/D14`
  machineCostEgpPerDay: number | null;
  workDays: number | null;
  /** `=J12/D17` — pieces per work day. */
  productivityRate: number | null;

  // Cost roll-up
  lines: CostLineResult[];
  fabricCostUsd: number | null;
  accessoryCostUsd: number | null;
  externalCostUsd: number | null;
  /** Cut-and-make. `=D17*D13` in EGP, converted here. */
  cmCostUsd: number | null;
  otherCostUsd: number | null;
  totalCostUsd: number | null;

  // Per unit
  unitActualCostUsd: number | null;
  unitActualCostEgp: number | null;
  sellPriceUsd: number | null;
  profitPerUnitUsd: number | null;
  profitPct: number | null;
  totalProfitUsd: number | null;
  /** `=IF(D26<=0, D24*1.2, "Perfect")` — the price that would restore a 20% margin. */
  targetPriceUsd: number | null;
  isProfitable: boolean | null;
}

export function computeCosting(input: CostingInput): CostingResult {
  const {
    orderQty, cutQty, shippedQty, dollarRate, dailyCostEgp, machineCount,
    machineDaysUsed, daysInLine, sellPriceUsd, lines,
    externalOpCostUsd = null, sublimationCostUsd = null, embroideryCostUsd = null,
  } = input;

  // --- Machine economics -------------------------------------------------
  const machineCostEgpPerDay = safeDiv(dailyCostEgp, machineCount);
  const workDays = safeDiv(machineDaysUsed, machineCount);
  const productivityRate = safeDiv(cutQty, workDays);

  // --- Line costs --------------------------------------------------------
  const priced: Array<CostLineInput & { cost: number | null }> = lines.map((l) => ({
    ...l,
    cost: l.quantity != null && l.unitPriceUsd != null ? l.quantity * l.unitPriceUsd : null,
  }));

  const groupTotal = (g: CostGroup): number | null => {
    const inGroup = priced.filter((l) => l.group === g);
    if (inGroup.length === 0) return null;
    // Null-safe: if nothing in the group is priced yet, report null, not a
    // misleading 0. A zero fabric cost and an unrecorded fabric cost are
    // different facts and the coordinator must be able to tell them apart.
    if (inGroup.every((l) => l.cost == null)) return null;
    return sum(inGroup.map((l) => l.cost));
  };

  const fabricCostUsd = groupTotal('FABRIC');
  const accessoryCostUsd = groupTotal('ACCESSORY');
  const otherCostUsd = groupTotal('OTHER');

  const externalParts = [groupTotal('EXTERNAL'), externalOpCostUsd, sublimationCostUsd, embroideryCostUsd];
  const externalCostUsd = externalParts.every((p) => p == null) ? null : sum(externalParts);

  // CM: work days × daily cost, EGP, converted to USD.
  const cmCostEgp = workDays != null && dailyCostEgp != null ? workDays * dailyCostEgp : null;
  const cmCostUsd = safeDiv(cmCostEgp, dollarRate);

  const costParts = [fabricCostUsd, accessoryCostUsd, externalCostUsd, cmCostUsd, otherCostUsd];
  const totalCostUsd = costParts.every((p) => p == null) ? null : sum(costParts);

  const linesOut: CostLineResult[] = priced.map((l) => ({
    ...l,
    pctOfTotal: safePct(l.cost, totalCostUsd),
  }));

  // --- Per unit ----------------------------------------------------------
  // The sheet divides by shipped qty and blows up when it is blank. We divide
  // by shipped qty when known, and fall back to nothing — not to cut qty —
  // because a unit cost against an assumed denominator is worse than none.
  const unitActualCostUsd = safeDiv(totalCostUsd, shippedQty);
  const unitActualCostEgp = unitActualCostUsd != null ? unitActualCostUsd * dollarRate : null;

  const profitPerUnitUsd =
    sellPriceUsd != null && unitActualCostUsd != null ? sellPriceUsd - unitActualCostUsd : null;
  const profitPct = safePct(profitPerUnitUsd, sellPriceUsd);
  const totalProfitUsd =
    profitPerUnitUsd != null && shippedQty != null ? profitPerUnitUsd * shippedQty : null;

  const isProfitable = profitPerUnitUsd == null ? null : profitPerUnitUsd > 0;
  const targetPriceUsd =
    profitPerUnitUsd != null && profitPerUnitUsd <= 0 && unitActualCostUsd != null
      ? unitActualCostUsd * 1.2
      : null;

  return {
    orderQty, cutQty, shippedQty,
    secondDegreeQty: shippedQty != null ? cutQty - shippedQty : null,
    shippedVsOrderedPct: shippedQty != null ? safePct(shippedQty, orderQty) : null,
    machineCostEgpPerDay, workDays, productivityRate,
    lines: linesOut,
    fabricCostUsd, accessoryCostUsd, externalCostUsd, cmCostUsd, otherCostUsd, totalCostUsd,
    unitActualCostUsd, unitActualCostEgp, sellPriceUsd,
    profitPerUnitUsd, profitPct, totalProfitUsd, targetPriceUsd, isProfitable,
  };
}

/** Convert an EGP price to USD — the sheet's `=0.4/$D$12` pattern, made explicit. */
export function egpToUsd(egp: number | null, dollarRate: number): number | null {
  return safeDiv(egp, dollarRate);
}

/** Order value at the agreed selling price. */
export function orderValueUsd(qty: number, pricePerPiece: number | null): number | null {
  return pricePerPiece == null ? null : qty * pricePerPiece;
}
