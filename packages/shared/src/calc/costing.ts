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
  /** `section:grouping` — what the line was derived from, where it was. */
  sourceRef?: string | null;
}

export type CostGroup = 'FABRIC' | 'ACCESSORY' | 'EXTERNAL' | 'LABOUR' | 'OTHER';

export interface CostLineResult extends CostLineInput {
  /** quantity × unitPriceUsd, or null if either is missing. */
  cost: number | null;
  /** Share of the total order cost. */
  pctOfTotal: number | null;
}

/** One section of the costing table, with the subtotal the sheet prints under it. */
export interface CostingSection {
  lines: CostLineResult[];
  /** Null when nothing in the section is priced — never a misleading zero. */
  total: number | null;
  pctOfTotal: number | null;
}

/**
 * The costing table as the sheet lays it out: UsedFabric with its Fabric
 * Costing subtotal, UsedAcc with its Accessory Costing subtotal, then the
 * outside-work rows.
 */
export interface CostingGroups {
  fabric: CostingSection;
  accessory: CostingSection;
  /** Outside work other than sublimation and embroidery, which have own rows. */
  external: CostingSection;
  other: CostingSection;
}

export interface CostingInput {
  orderQty: number;
  cutQty: number;
  shippedQty: number | null;
  /**
   * EGP per USD. 48.5 in the source workbook.
   *
   * Nullable because the sheet is shown from the moment the order exists, and
   * before anybody has opened the costing there is no rate. Every conversion
   * that needs one goes through `safeDiv`, so an unset rate leaves those cells
   * uncalculated rather than converting at a rate nobody chose.
   */
  dollarRate: number | null;
  /** Factory daily running cost in EGP. 1867 in the source workbook. */
  dailyCostEgp: number | null;
  /** Total machines on the floor. 38 in the source workbook. */
  machineCount: number | null;
  /** Machine-days actually consumed by this order. 130 in the source workbook. */
  machineDaysUsed: number | null;
  /** Calendar days the order occupied a line. 11 in the source workbook. */
  daysInLine: number | null;
  /** Machines on this order's line. The sheet's "Line Machines Qty". */
  lineMachineQty?: number | null;
  /** Whether a costing record has been saved for this order. */
  hasRecord?: boolean;
  /** A-grade output. The sheet's "1st Degree Qty". */
  firstDegreeQty?: number | null;
  /** B-grade output. The sheet's "2nd Degree Qty". */
  secondDegreeQty?: number | null;
  /** Selling price per piece in USD. 7.25 for this order. */
  sellPriceUsd: number | null;
  /** The date the costing was struck. */
  costingDate?: string | null;
  /** The sheet's Notes row. */
  notes?: string | null;
  lines: readonly CostLineInput[];
  externalOpCostUsd?: number | null;
  sublimationCostUsd?: number | null;
  embroideryCostUsd?: number | null;
}

export interface CostingResult {
  /** True when a costing record has been saved; false while the sheet is live
   *  off the order alone and nobody has entered the factory's figures yet. */
  hasRecord: boolean;
  costingDate: string | null;
  /** EGP per USD, as stored with the costing. Null until one is set. */
  dollarRate: number | null;
  /** The factory's daily running cost in EGP, as stored. */
  dailyCostEgp: number | null;
  /** Whatever the coordinator wrote in the sheet's Notes row. */
  notes: string | null;
  /** Factory-wide machine count, as stored. */
  machineCount: number | null;
  /** Machine-days this order consumed, as stored. */
  machineDaysUsed: number | null;

  // Volumes
  orderQty: number;
  cutQty: number;
  shippedQty: number | null;
  /** A-grade output — pieces that passed end-line inspection. */
  firstDegreeQty: number | null;
  /** B-grade output, as recorded against the second-degree ledger. */
  secondDegreeQty: number | null;
  /**
   * The sheet's "Diff. Percentage", `=(L11/J11)-100%`: how far shipped is from
   * ordered, signed. −10% means ten per cent short; 0% means exactly the order.
   */
  diffPct: number | null;
  /** Shipped as a share of ordered, 0–100. The same ratio, unsigned. */
  shippedVsOrderedPct: number | null;

  // Machine economics — `=D13/D14` and `=D22/D14`
  machineCostEgpPerDay: number | null;
  workDays: number | null;
  /** `=J12/D17` — pieces per work day. */
  productivityRate: number | null;
  /** Machines on this order's line, as recorded. */
  lineMachineQty: number | null;
  /** Calendar days the order occupied a line, as recorded. */
  daysInLine: number | null;

  // Cost roll-up
  lines: CostLineResult[];
  /** The costing table, in the sheet's own sections. */
  groups: CostingGroups;
  fabricCostUsd: number | null;
  accessoryCostUsd: number | null;
  externalCostUsd: number | null;
  /** Outside work billed as sublimation, from whichever source recorded it. */
  sublimationCostUsd: number | null;
  /** Outside work billed as embroidery. */
  embroideryCostUsd: number | null;
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
    lineMachineQty = null, firstDegreeQty = null, secondDegreeQty = null,
    externalOpCostUsd = null, sublimationCostUsd = null, embroideryCostUsd = null,
  } = input;

  // --- Machine economics -------------------------------------------------
  // Actual Costing!D16/D17/D18, unchanged: cost per machine-day, the factory
  // days this order consumed, and pieces cut per factory day.
  const machineCostEgpPerDay = safeDiv(dailyCostEgp, machineCount);
  const workDays = safeDiv(machineDaysUsed, machineCount);
  const productivityRate = safeDiv(cutQty, workDays);

  // --- Line costs --------------------------------------------------------
  const priced: Array<CostLineInput & { cost: number | null }> = lines.map((l) => ({
    ...l,
    cost: l.quantity != null && l.unitPriceUsd != null ? l.quantity * l.unitPriceUsd : null,
  }));

  /**
   * Outside work reaches the costing twice over: as lines derived from the
   * External Order section, and as the three figures somebody can type
   * straight onto the costing record. Adding both would bill sublimation
   * twice, so a typed figure replaces the derived lines for that operation
   * rather than joining them.
   */
  const isKind = (l: CostLineInput, word: string): boolean =>
    `${l.label} ${l.sourceRef ?? ''}`.toUpperCase().includes(word);

  const externalLines = priced.filter((l) => l.group === 'EXTERNAL');
  const sublimationLines = externalLines.filter((l) => isKind(l, 'SUBLIMATION'));
  const embroideryLines = externalLines.filter((l) => isKind(l, 'EMBROIDER'));
  const otherExternalLines = externalLines.filter(
    (l) => !sublimationLines.includes(l) && !embroideryLines.includes(l),
  );

  const totalOf = (group: readonly { cost: number | null }[]): number | null => {
    if (group.length === 0) return null;
    // A zero cost and an unrecorded cost are different facts, and the screen
    // renders them differently. Nothing priced yet means null, not 0.
    if (group.every((l) => l.cost == null)) return null;
    return sum(group.map((l) => l.cost));
  };

  const byGroup = (g: CostGroup) => priced.filter((l) => l.group === g);
  const fabricLines = byGroup('FABRIC');
  const accessoryLines = byGroup('ACCESSORY');
  const otherLines = byGroup('OTHER');

  const fabricCostUsd = totalOf(fabricLines);
  const accessoryCostUsd = totalOf(accessoryLines);
  const otherCostUsd = totalOf(otherLines);

  const resolvedSublimation = sublimationCostUsd ?? totalOf(sublimationLines);
  const resolvedEmbroidery = embroideryCostUsd ?? totalOf(embroideryLines);
  const otherExternalCostUsd = totalOf(otherExternalLines);

  const externalParts = [otherExternalCostUsd, externalOpCostUsd, resolvedSublimation, resolvedEmbroidery];
  const externalCostUsd = externalParts.every((p) => p == null) ? null : sum(externalParts);

  // CM: the sheet's `=D17*D13` — factory days × daily running cost, in EGP,
  // converted at the rate stored with the costing.
  const cmCostEgp = workDays != null && dailyCostEgp != null ? workDays * dailyCostEgp : null;
  const cmCostUsd = safeDiv(cmCostEgp, dollarRate);

  const costParts = [fabricCostUsd, accessoryCostUsd, externalCostUsd, cmCostUsd, otherCostUsd];
  const totalCostUsd = costParts.every((p) => p == null) ? null : sum(costParts);

  const withPct = (l: CostLineInput & { cost: number | null }): CostLineResult => ({
    ...l, pctOfTotal: safePct(l.cost, totalCostUsd),
  });
  const linesOut: CostLineResult[] = priced.map(withPct);

  const section = (group: readonly (CostLineInput & { cost: number | null })[]): CostingSection => {
    const total = totalOf(group);
    return { lines: group.map(withPct), total, pctOfTotal: safePct(total, totalCostUsd) };
  };

  const groups: CostingGroups = {
    fabric: section(fabricLines),
    accessory: section(accessoryLines),
    external: section(otherExternalLines),
    other: section(otherLines),
  };

  // --- Per unit ----------------------------------------------------------
  // The sheet divides by shipped qty and blows up when it is blank. We divide
  // by shipped qty when known, and fall back to nothing — not to cut qty —
  // because a unit cost against an assumed denominator is worse than none.
  const unitActualCostUsd = safeDiv(totalCostUsd, shippedQty);
  const unitActualCostEgp =
    unitActualCostUsd != null && dollarRate != null ? unitActualCostUsd * dollarRate : null;

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

  // The sheet's Diff. Percentage is `=(L11/J11)-100%`: signed distance from the
  // order, not the fraction of it. Shipping 900 of 1,000 reads −10%.
  const shippedShare = shippedQty != null ? safePct(shippedQty, orderQty) : null;

  return {
    hasRecord: input.hasRecord ?? true,
    costingDate: input.costingDate ?? null,
    dollarRate, dailyCostEgp, machineCount, machineDaysUsed,
    notes: input.notes ?? null,
    orderQty, cutQty, shippedQty,
    firstDegreeQty, secondDegreeQty,
    diffPct: shippedShare == null ? null : shippedShare - 100,
    shippedVsOrderedPct: shippedShare,
    machineCostEgpPerDay, workDays, productivityRate,
    lineMachineQty, daysInLine,
    lines: linesOut, groups,
    fabricCostUsd, accessoryCostUsd, externalCostUsd,
    sublimationCostUsd: resolvedSublimation,
    embroideryCostUsd: resolvedEmbroidery,
    cmCostUsd, otherCostUsd, totalCostUsd,
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
