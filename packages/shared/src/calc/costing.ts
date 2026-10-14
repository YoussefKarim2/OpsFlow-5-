/**
 * Actual costing — the brief's section 25.
 *
 * Ports `Actual Costing_Coordinator`. Everything is in US dollars: the daily
 * cost, every unit price, every total. The workbook quoted accessories and
 * the daily cost in Egyptian pounds and converted at a stored rate
 * (`=0.4/$D$12`); OpsFlow has no second currency and no rate — a figure is
 * typed in dollars or it is not a figure. Its CM formula (`=D17*D13` — work
 * days × daily cost) is charged against the pieces that passed inspection
 * here; see the C.M block below.
 *
 * The live sheet shows `#DIV/0!` in five cells today because shipped qty is
 * still blank. Every one of those divisions goes through `safeDiv` here, so the
 * same state renders as "Not calculated" instead.
 */

import { safeDiv, safePct, sum } from './num.js';
import {
  numericOverride, textOverride, type CostingOverrides, type OverrideKey,
} from './costing-overrides.js';

export interface CostLineInput {
  /** 'FABRIC' | 'ACCESSORY' | 'EXTERNAL' | 'LABOUR' | 'OTHER' */
  group: CostGroup;
  label: string;
  /** Actual consumption. Null when not yet recorded. */
  quantity: number | null;
  unit: string;
  /** Unit price in USD. */
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
  /** Factory daily running cost in US dollars. */
  dailyCostUsd: number | null;
  /** Total machines on the floor. 38 in the source workbook. */
  machineCount: number | null;
  /** Machine-days actually consumed by this order. 130 in the source workbook. */
  machineDaysUsed: number | null;
  /** Calendar days the order occupied a line. 11 in the source workbook. */
  daysInLine: number | null;
  /**
   * Days with sewing output recorded against the order — the production
   * records' own answer to "how many days was it on the line". Used for the
   * machine-days only when nobody has typed the days in line.
   */
  sewingDays?: number | null;
  /** Where the cut quantity came from: what the cutting floor recorded, or the cut order. */
  cutQtySource?: 'recorded' | 'cut order' | null;
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
  /** The identity cells, as the order records them. Overridable for display. */
  customer?: string | null;
  orderName?: string | null;
  itemType?: string | null;
  poNumber?: string | null;
  styleNumber?: string | null;
  lines: readonly CostLineInput[];
  /**
   * Figures typed straight over the calculated ones. They cascade: override
   * the fabric total and the grand total, unit cost and profit move with it.
   * The facts underneath — ledgers, bill of materials, order — are untouched,
   * so clearing an override falls straight back to the live number.
   */
  overrides?: CostingOverrides;
  externalOpCostUsd?: number | null;
  sublimationCostUsd?: number | null;
  embroideryCostUsd?: number | null;
}

/**
 * The facts the costing is computed from, before anything is typed over them.
 *
 * Published so the screen can run this same function on every keystroke and
 * show the whole chain updating, rather than waiting for a round trip and
 * risking a second implementation of the arithmetic that drifts from this one.
 */
export interface CostingSource {
  orderQty: number;
  cutQty: number;
  cutQtySource: 'recorded' | 'cut order' | null;
  sewingDays: number | null;
  shippedQty: number | null;
  firstDegreeQty: number | null;
  secondDegreeQty: number | null;
  sellPriceUsd: number | null;
  externalOpCostUsd: number | null;
  customer: string | null;
  orderName: string | null;
  itemType: string | null;
  poNumber: string | null;
  styleNumber: string | null;
}

export interface CostingResult {
  /** The unoverridden facts, so the same computation can be run anywhere. */
  source: CostingSource;
  /**
   * Why a figure could not be worked out, keyed by field. Present only for the
   * ones that are null: "Waiting for the shipped quantity" is an answer a
   * person can act on; `#DIV/0!` is not.
   */
  waiting: Partial<Record<string, string>>;
  /** Which cells are showing a typed figure instead of the calculated one. */
  overridden: OverrideKey[];
  /** What each overridden cell would say if the override were cleared. */
  calculated: Partial<Record<OverrideKey, number | string | null>>;
  /** The identity cells, after any override. Display only. */
  identity: {
    customer: string | null; orderName: string | null; itemType: string | null;
    poNumber: string | null; styleNumber: string | null;
  };
  /** True when a costing record has been saved; false while the sheet is live
   *  off the order alone and nobody has entered the factory's figures yet. */
  hasRecord: boolean;
  costingDate: string | null;
  /** The factory's daily running cost in dollars, as stored. */
  dailyCostUsd: number | null;
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
  /** Dollars per machine-day: daily cost over all factory machines. */
  machineCostPerDay: number | null;
  workDays: number | null;
  /** `=J12/D17` — pieces per work day. */
  productivityRate: number | null;
  /** Machines on this order's line, as recorded. */
  lineMachineQty: number | null;
  /** Calendar days the order occupied a line, as recorded. */
  daysInLine: number | null;
  /** The days in line the machine-days were worked out from: typed, or the sewing days. */
  daysInLineUsed: number | null;
  daysInLineSource: 'typed' | 'production' | null;

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
  /** Cut-and-make: daily cost ÷ productivity rate × 1st degree qty. */
  cmCostUsd: number | null;
  otherCostUsd: number | null;
  totalCostUsd: number | null;

  // Per unit
  unitActualCostUsd: number | null;
  sellPriceUsd: number | null;
  profitPerUnitUsd: number | null;
  profitPct: number | null;
  totalProfitUsd: number | null;
  /**
   * `=IF(D26<=0, D24*1.2, "Perfect")` — cost plus a 20% mark-up, the sheet's
   * own rule. A 20% mark-up is a 16.7% margin on the new price, not 20%.
   */
  targetPriceUsd: number | null;
  isProfitable: boolean | null;
}

export function computeCosting(input: CostingInput): CostingResult {
  const {
    orderQty: orderQtyIn, cutQty: cutQtyIn, shippedQty: shippedQtyIn,
    dailyCostUsd, machineCount,
    machineDaysUsed: machineDaysUsedIn, daysInLine, sewingDays = null,
    sellPriceUsd: sellPriceIn, lines,
    lineMachineQty = null, firstDegreeQty: firstDegreeIn = null,
    secondDegreeQty: secondDegreeIn = null, overrides,
    externalOpCostUsd = null, sublimationCostUsd = null, embroideryCostUsd = null,
  } = input;

  /**
   * A cell's value: the typed one when there is one, else the calculated one.
   *
   * Both are recorded as they are resolved, so the screen can show what the
   * figure would be if the override were cleared. A number nobody can put back
   * is a number nobody can trust.
   */
  const overridden: OverrideKey[] = [];
  const calculated: Partial<Record<OverrideKey, number | string | null>> = {};
  const pick = (key: OverrideKey, computed: number | null): number | null => {
    const typed = numericOverride(overrides, key);
    if (typed == null) return computed;
    overridden.push(key);
    calculated[key] = computed;
    return typed;
  };
  const pickText = (key: OverrideKey, computed: string | null): string | null => {
    const typed = textOverride(overrides, key);
    if (typed == null) return computed;
    overridden.push(key);
    calculated[key] = computed;
    return typed;
  };

  // --- Quantities --------------------------------------------------------
  // Overridden first, because everything downstream counts them.
  const orderQty = pick('orderQty', orderQtyIn) ?? 0;
  const cutQty = pick('cutQty', cutQtyIn) ?? 0;
  const shippedQty = pick('shippedQty', shippedQtyIn);
  const firstDegreeQty = pick('firstDegreeQty', firstDegreeIn);
  const secondDegreeQty = pick('secondDegreeQty', secondDegreeIn);
  const sellPriceUsd = pick('sellPriceUsd', sellPriceIn);

  // --- Machine economics -------------------------------------------------
  // Actual Costing!D16/D17/D18: cost per machine-day, the factory days this
  // order consumed, and pieces cut per factory day.
  const machineCostPerDay = pick('machineCostPerDay', safeDiv(dailyCostUsd, machineCount));

  /**
   * Machine-days this order consumed.
   *
   * The machines on its line, for the days it held them. Nobody should be
   * multiplying those two by hand when the sheet holds both, so it is worked
   * out whenever both are present. An order costed before this — or one whose
   * line and days were never recorded — keeps the figure that was stored, and
   * typing over the field still wins, as it does everywhere on this sheet.
   */
  // Days in line: what was typed, else the days the production records show
  // sewing on this order. A typed figure always wins; the records only fill
  // the gap, so nobody has to count days the application already counted.
  const daysInLineUsed = daysInLine ?? (sewingDays != null && sewingDays > 0 ? sewingDays : null);
  const daysInLineSource: CostingResult['daysInLineSource'] =
    daysInLine != null ? 'typed' : daysInLineUsed != null ? 'production' : null;
  const machineDaysUsed = pick(
    'machineDaysUsed',
    lineMachineQty != null && daysInLineUsed != null
      ? lineMachineQty * daysInLineUsed
      : machineDaysUsedIn,
  );

  const workDays = pick('workDays', safeDiv(machineDaysUsed, machineCount));
  const productivityRate = pick('productivityRate', safeDiv(cutQty, workDays));

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
   *
   * Each operation belongs to exactly one row (`outsideWorkKind`).
   * Sorted rather than filtered three times: an operation called "Sublimation
   * embroidery" matched both tests and was added to the total twice, so a job
   * costing 500 arrived on the sheet as 1,000. Sublimation is decided first
   * because that is the printing step; whatever matches neither keeps its own
   * row.
   */
  const externalLines = priced.filter((l) => l.group === 'EXTERNAL');
  const sublimationLines: typeof externalLines = [];
  const embroideryLines: typeof externalLines = [];
  const otherExternalLines: typeof externalLines = [];
  for (const line of externalLines) {
    const kind = outsideWorkKind(line);
    if (kind === 'SUBLIMATION') sublimationLines.push(line);
    else if (kind === 'EMBROIDERY') embroideryLines.push(line);
    else otherExternalLines.push(line);
  }

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
  // Labour lines have no section of their own on the sheet, so they are
  // listed — and totalled — with the other costs. Listed without being
  // totalled, a row showed a share of a figure it was not part of.
  const otherLines = [...byGroup('LABOUR'), ...byGroup('OTHER')];

  const fabricCostUsd = pick('fabricCostUsd', totalOf(fabricLines));
  const accessoryCostUsd = pick('accessoryCostUsd', totalOf(accessoryLines));
  const otherCostUsd = totalOf(otherLines);

  const resolvedSublimation = sublimationCostUsd ?? totalOf(sublimationLines);
  const resolvedEmbroidery = embroideryCostUsd ?? totalOf(embroideryLines);
  const otherExternalCostUsd = totalOf(otherExternalLines);

  const externalParts = [otherExternalCostUsd, externalOpCostUsd, resolvedSublimation, resolvedEmbroidery];
  const externalCostUsd = externalParts.every((p) => p == null) ? null : sum(externalParts);

  /**
   * Cut-and-make.
   *
   *   daily cost ÷ productivity rate × 1st degree qty
   *
   * The factory costs its daily figure for every day it runs, and the
   * productivity rate is how many pieces this order got out of one such day
   * (cut ÷ work days, where work days = machine-days ÷ all machines). One over
   * the other is what a piece cost to make, and the pieces that passed
   * end-line inspection are the ones it is charged against.
   *
   * Written out, that is the machine run cost — machine cost × machine-days —
   * spread over the pieces cut and charged for the pieces that passed:
   *
   *   machine cost × machine-days ÷ cut qty × 1st degree qty
   *
   * so when every cut piece passes it is exactly the workbook's `=D17*D13`,
   * work days × daily cost. An earlier version divided the whole run cost by
   * the productivity rate instead of the daily cost; the units of that are
   * dollars × days, not dollars, and it charged an order work-days times what its
   * machines had cost to run (3.3× on an 11-day order).
   *
   * Nothing is rounded on the way through — only the figure that reaches the
   * screen is formatted — and every division goes through `safeDiv`, so a
   * productivity rate of zero or an unrecorded one leaves the whole thing
   * uncalculated rather than infinite.
   */
  const costPerPiece = safeDiv(dailyCostUsd, productivityRate);
  const cmCostUsd = pick(
    'cmCostUsd',
    costPerPiece != null && firstDegreeQty != null ? costPerPiece * firstDegreeQty : null,
  );

  const costParts = [fabricCostUsd, accessoryCostUsd, externalCostUsd, cmCostUsd, otherCostUsd];
  const totalCostUsd = pick('totalCostUsd', costParts.every((p) => p == null) ? null : sum(costParts));

  const withPct = (l: CostLineInput & { cost: number | null }): CostLineResult => ({
    ...l, pctOfTotal: safePct(l.cost, totalCostUsd),
  });
  const linesOut: CostLineResult[] = priced.map(withPct);

  const section = (
    group: readonly (CostLineInput & { cost: number | null })[],
    total: number | null,
  ): CostingSection => ({
    lines: group.map(withPct), total, pctOfTotal: safePct(total, totalCostUsd),
  });

  const groups: CostingGroups = {
    fabric: section(fabricLines, fabricCostUsd),
    accessory: section(accessoryLines, accessoryCostUsd),
    external: section(otherExternalLines, otherExternalCostUsd),
    other: section(otherLines, otherCostUsd),
  };

  // --- Per unit ----------------------------------------------------------
  // The sheet divides by shipped qty and blows up when it is blank. We divide
  // by shipped qty when known, and fall back to nothing — not to cut qty —
  // because a unit cost against an assumed denominator is worse than none.
  const unitActualCostUsd = pick('unitActualCostUsd', safeDiv(totalCostUsd, shippedQty));

  const profitPerUnitUsd = pick(
    'profitPerUnitUsd',
    sellPriceUsd != null && unitActualCostUsd != null ? sellPriceUsd - unitActualCostUsd : null,
  );
  const profitPct = pick('profitPct', safePct(profitPerUnitUsd, sellPriceUsd));
  const totalProfitUsd =
    profitPerUnitUsd != null && shippedQty != null ? profitPerUnitUsd * shippedQty : null;

  const isProfitable = profitPerUnitUsd == null ? null : profitPerUnitUsd > 0;
  const targetPriceUsd = pick(
    'targetPriceUsd',
    profitPerUnitUsd != null && profitPerUnitUsd <= 0 && unitActualCostUsd != null
      ? unitActualCostUsd * 1.2
      : null,
  );

  // The sheet's Diff. Percentage is `=(L11/J11)-100%`: signed distance from the
  // order, not the fraction of it. Shipping 900 of 1,000 reads −10%.
  const shippedShare = shippedQty != null ? safePct(shippedQty, orderQty) : null;
  const diffPct = pick('diffPct', shippedShare == null ? null : shippedShare - 100);

  /**
   * What each missing figure is missing.
   *
   * Filled from the inputs rather than guessed from the output, so the message
   * names the fact a person can go and record — and never appears next to a
   * figure that did compute.
   */
  const waiting: Partial<Record<string, string>> = {};
  const needs = (key: string, value: number | null, reason: string | null) => {
    if (value == null && reason != null) waiting[key] = reason;
  };

  const noMachines = machineCount == null || machineCount === 0 ? 'the factory machine count' : null;
  const noDaily = dailyCostUsd == null ? "the factory's daily cost" : null;

  needs('machineCostPerDay', machineCostPerDay,
    noDaily && noMachines ? `Waiting for ${noDaily} and ${noMachines}`
      : noDaily ? `Waiting for ${noDaily}`
      : noMachines ? `Waiting for ${noMachines}` : null);
  needs('workDays', workDays,
    machineDaysUsed == null && noMachines ? 'Waiting for the machine-days used and the machine count'
      : machineDaysUsed == null ? 'Waiting for the machine-days used'
      : noMachines ? `Waiting for ${noMachines}` : null);
  // Cut quantity is always a number, so a rate that did not compute against
  // known work days means the work days were zero — nothing can be produced
  // per day in no days, and asking for a cut quantity sent people to the wrong
  // screen.
  needs('productivityRate', productivityRate,
    workDays == null ? 'Waiting for the work days'
      : workDays === 0 ? 'Waiting for work days above zero — the machine-days used is 0'
      : 'Waiting for a cut quantity');
  needs('cmCostUsd', cmCostUsd,
    noDaily ? `Waiting for ${noDaily}`
      : machineDaysUsed == null ? 'Waiting for the line machines and days in line'
      : productivityRate == null || productivityRate === 0 ? 'Waiting for the productivity rate'
      : firstDegreeQty == null ? 'Waiting for the 1st degree quantity' : null);
  needs('machineDaysUsed', machineDaysUsed,
    lineMachineQty == null ? 'Waiting for the line machines'
      : 'Waiting for the days in line — type them, or record sewing on the Production step');
  needs('fabricCostUsd', fabricCostUsd,
    fabricLines.length === 0 ? 'No fabric on the bill of materials yet'
      : 'Waiting for a unit price on the fabric rows');
  needs('accessoryCostUsd', accessoryCostUsd,
    accessoryLines.length === 0 ? 'No accessories on the bill of materials yet'
      : 'Waiting for a unit price on the accessory rows');
  needs('totalCostUsd', totalCostUsd, 'Waiting for a priced cost row');
  needs('unitActualCostUsd', unitActualCostUsd,
    totalCostUsd == null ? 'Waiting for the costs below'
      : shippedQty == null || shippedQty === 0 ? 'Waiting for the shipped quantity' : null);
  needs('profitPerUnitUsd', profitPerUnitUsd,
    sellPriceUsd == null ? 'Waiting for the sell price'
      : 'Waiting for the actual cost per unit');
  needs('profitPct', profitPct,
    profitPerUnitUsd == null ? 'Waiting for the profit'
      : 'Waiting for the sell price');
  needs('diffPct', diffPct,
    shippedQty == null ? 'Waiting for the shipped quantity'
      : orderQty === 0 ? 'Waiting for an order quantity' : null);
  needs('targetPriceUsd', targetPriceUsd,
    profitPerUnitUsd == null ? 'Waiting for the profit' : null);
  needs('sellPriceUsd', sellPriceUsd, 'Waiting for a price per piece on Order Details');
  needs('shippedQty', shippedQty, 'Waiting for a shipment to be recorded');

  return {
    source: {
      orderQty: orderQtyIn, cutQty: cutQtyIn, shippedQty: shippedQtyIn,
      cutQtySource: input.cutQtySource ?? null, sewingDays,
      firstDegreeQty: firstDegreeIn, secondDegreeQty: secondDegreeIn,
      sellPriceUsd: sellPriceIn, externalOpCostUsd,
      customer: input.customer ?? null,
      orderName: input.orderName ?? null,
      itemType: input.itemType ?? null,
      poNumber: input.poNumber ?? null,
      styleNumber: input.styleNumber ?? null,
    },
    waiting,
    overridden, calculated,
    identity: {
      customer: pickText('customer', input.customer ?? null),
      orderName: pickText('orderName', input.orderName ?? null),
      itemType: pickText('itemType', input.itemType ?? null),
      poNumber: pickText('poNumber', input.poNumber ?? null),
      styleNumber: pickText('styleNumber', input.styleNumber ?? null),
    },
    hasRecord: input.hasRecord ?? true,
    costingDate: input.costingDate ?? null,
    dailyCostUsd, machineCount, machineDaysUsed,
    notes: input.notes ?? null,
    orderQty, cutQty, shippedQty,
    firstDegreeQty, secondDegreeQty,
    diffPct,
    shippedVsOrderedPct: shippedShare,
    machineCostPerDay, workDays, productivityRate,
    lineMachineQty, daysInLine, daysInLineUsed, daysInLineSource,
    lines: linesOut, groups,
    fabricCostUsd, accessoryCostUsd, externalCostUsd,
    sublimationCostUsd: resolvedSublimation,
    embroideryCostUsd: resolvedEmbroidery,
    cmCostUsd, otherCostUsd, totalCostUsd,
    unitActualCostUsd, sellPriceUsd,
    profitPerUnitUsd, profitPct, totalProfitUsd, targetPriceUsd, isProfitable,
  };
}

/**
 * Which of the sheet's dedicated outside-work rows an EXTERNAL line belongs to.
 *
 * Sublimation and embroidery have rows of their own on the sheet, so their
 * lines are totalled there and must not be listed again among the other
 * outside work. Read from the label and the source reference together, and
 * sublimation is decided first: an operation called "Sublimation embroidery"
 * once matched both and was billed twice. Null means it keeps a row of its own.
 */
export function outsideWorkKind(
  line: Pick<CostLineInput, 'label' | 'sourceRef'>,
): 'SUBLIMATION' | 'EMBROIDERY' | null {
  const text = `${line.label} ${line.sourceRef ?? ''}`.toUpperCase();
  if (text.includes('SUBLIMATION')) return 'SUBLIMATION';
  if (text.includes('EMBROIDER')) return 'EMBROIDERY';
  return null;
}

/** Order value at the agreed selling price. */
export function orderValueUsd(qty: number, pricePerPiece: number | null): number | null {
  return pricePerPiece == null ? null : qty * pricePerPiece;
}
