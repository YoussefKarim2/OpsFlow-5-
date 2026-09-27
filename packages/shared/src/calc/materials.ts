/**
 * Materials, BOM shortages, and the marker/lay engine.
 *
 * Replaces `Bill Of Matrial_Coord_Warehouse` (whose shortage column is
 * `=K17-I17`) and `Laying fabric instructions_Patr` (whose lay rows carry a
 * size ratio like `(YXS1), (YS1), (YM1), (YL1), (M1)` at 140 layers).
 */

import { BomCategory } from '../enums.js';
import { safeDiv, safePct, sum } from './num.js';

export interface BomItemInput {
  id: string;
  category: BomCategory;
  position?: string | null;
  item: string;
  description?: string | null;
  color?: string | null;
  unit: string;
  consumptionPerPiece?: number | null;
  requiredQty: number;
  issuedQty: number;
}

export interface BomItemResult extends BomItemInput {
  /** issued − required. Negative = short, matching the workbook's sign convention. */
  shortage: number;
  /** Absolute quantity still to issue. 0 when fully covered. */
  shortQty: number;
  coveragePct: number | null;
  status: 'NOT_ISSUED' | 'PARTIAL' | 'COMPLETE' | 'OVER_ISSUED';
}

export function computeBomItem(i: BomItemInput): BomItemResult {
  const shortage = i.issuedQty - i.requiredQty;
  const shortQty = shortage < 0 ? Math.abs(shortage) : 0;
  let status: BomItemResult['status'];
  if (i.issuedQty <= 0) status = 'NOT_ISSUED';
  else if (shortage < 0) status = 'PARTIAL';
  else if (shortage > 0) status = 'OVER_ISSUED';
  else status = 'COMPLETE';
  return { ...i, shortage, shortQty, coveragePct: safePct(i.issuedQty, i.requiredQty), status };
}

export interface BomSummary {
  items: BomItemResult[];
  totalItems: number;
  shortItems: number;
  completeItems: number;
  notIssuedItems: number;
  /** True when nothing is outstanding — gates READY_FOR_PRODUCTION. */
  fullyIssued: boolean;
  overallCoveragePct: number | null;
  /** The worst offenders, for the overview panel and alerts. */
  topShortages: BomItemResult[];
}

export function computeBomSummary(items: readonly BomItemInput[]): BomSummary {
  const results = items.map(computeBomItem);
  const shortItems = results.filter((r) => r.shortQty > 0);
  const totalRequired = sum(results.map((r) => r.requiredQty));
  const totalIssued = sum(results.map((r) => Math.min(r.issuedQty, r.requiredQty)));
  return {
    items: results,
    totalItems: results.length,
    shortItems: shortItems.length,
    completeItems: results.filter((r) => r.status === 'COMPLETE' || r.status === 'OVER_ISSUED').length,
    notIssuedItems: results.filter((r) => r.status === 'NOT_ISSUED').length,
    fullyIssued: results.length > 0 && shortItems.length === 0,
    overallCoveragePct: safePct(totalIssued, totalRequired),
    topShortages: [...shortItems].sort((a, b) => b.shortQty - a.shortQty).slice(0, 5),
  };
}

/** Group BOM lines by category for the sectioned BOM table. */
export function groupBomByCategory(items: readonly BomItemResult[]): Array<{
  category: BomCategory;
  items: BomItemResult[];
  shortCount: number;
}> {
  const map = new Map<BomCategory, BomItemResult[]>();
  for (const i of items) {
    const arr = map.get(i.category) ?? [];
    arr.push(i);
    map.set(i.category, arr);
  }
  return [...map.entries()].map(([category, list]) => ({
    category,
    items: list,
    shortCount: list.filter((x) => x.shortQty > 0).length,
  }));
}

// ---------------------------------------------------------------------------
// Marker / lay engine
// ---------------------------------------------------------------------------

/**
 * One lay from the `Laying fabric instructions` sheet, e.g.
 *   fabric=Rosetta, colour=White, panel=ALL,
 *   ratio="(YXS1), (YS1), (YM1), (YL1), (M1)", layers=140,
 *   markerLength=2.61, totalLength=391, nest=5
 */
export interface LayInput {
  id: string;
  fabric: string;
  color: string;
  panel: string;
  /** Raw ratio string, parsed by `parseSizeRatio`. */
  ratio: string;
  layers: number;
  markerLengthM: number;
  /**
   * Metres the lay actually consumes, as recorded on the sheet.
   *
   * This is NOT `layers × markerLengthM`. On PO A302059B the two differ by
   * about 7% — the end loss and splice allowance on every lay — which comes to
   * 80 m across six lays. When the recorded figure is absent the product is
   * used as a floor, and `allowancePct` reports the difference so the planner
   * can see it rather than discovering it on the cutting floor.
   */
  totalLengthM?: number | null;
  nestPcs?: number | null;
  efficiencyPct?: number | null;
}

export interface LayResult extends Omit<LayInput, 'totalLengthM'> {
  /** Parsed size → pieces-per-layer. */
  perLayer: Record<string, number>;
  /** Parsed size → total pieces produced by this lay. */
  output: Record<string, number>;
  totalPieces: number;
  /** layers × markerLength — the marker alone, before any lay allowance. */
  theoreticalLengthM: number;
  /** Metres actually consumed: the recorded figure, or the product as a floor. */
  totalLengthM: number;
  /** How far the real consumption exceeds the marker product. */
  allowancePct: number | null;
  /** Metres of fabric consumed per finished piece. */
  consumptionPerPieceM: number | null;
}

/**
 * Parse `(YXS1), (YS1), (YM1), (YL1), (M1)` → `{YXS:1, YS:1, YM:1, YL:1, M:1}`
 * and `(2YXS1), (S3), (L1), (XL1)` → `{'2YXS':1, S:3, L:1, XL:1}`.
 *
 * Note the size token may itself start with digits (2YXS, 2XL, 3XL), so the
 * count is taken as the trailing digits only.
 */
export function parseSizeRatio(ratio: string): Record<string, number> {
  const out: Record<string, number> = {};
  const groups = ratio.match(/\(([^)]+)\)/g) ?? [];
  for (const g of groups) {
    const inner = g.slice(1, -1).trim();
    const m = inner.match(/^(.*?)(\d+)$/);
    if (!m) continue;
    const size = (m[1] ?? '').trim();
    const count = Number(m[2]);
    if (!size || !Number.isFinite(count)) continue;
    out[size] = (out[size] ?? 0) + count;
  }
  return out;
}

export function computeLay(lay: LayInput): LayResult {
  const perLayer = parseSizeRatio(lay.ratio);
  const output: Record<string, number> = {};
  for (const [size, per] of Object.entries(perLayer)) output[size] = per * lay.layers;
  const totalPieces = sum(Object.values(output));
  const theoreticalLengthM = lay.layers * lay.markerLengthM;
  const totalLengthM = lay.totalLengthM ?? theoreticalLengthM;
  return {
    ...lay,
    perLayer,
    output,
    totalPieces,
    theoreticalLengthM,
    totalLengthM,
    allowancePct: safePct(totalLengthM - theoreticalLengthM, theoreticalLengthM),
    consumptionPerPieceM: safeDiv(totalLengthM, totalPieces),
  };
}

export interface MarkerPlanSummary {
  lays: LayResult[];
  /** Size → total pieces the lay plan produces. */
  plannedBySize: Record<string, number>;
  plannedTotal: number;
  /** Size → cut requirement. */
  requiredBySize: Record<string, number>;
  requiredTotal: number;
  /** Size → planned − required. The workbook's `(+/-)` row. */
  varianceBySize: Record<string, number>;
  varianceTotal: number;
  totalLayers: number;
  totalFabricM: number;
  /** Sum of layers × markerLength, before the lay allowance. */
  theoreticalFabricM: number;
  /** totalFabricM − theoreticalFabricM: end loss and splice waste. */
  allowanceM: number;
  allowancePct: number | null;
  avgConsumptionPerPieceM: number | null;
  /** Fabric efficiency: required pieces vs planned pieces. */
  planEfficiencyPct: number | null;
  /**
   * The fabric whose lays count as garments — see `garmentLayIds`. Null when
   * there are no lays.
   */
  mainFabric: string | null;
  /** The lays whose pieces count toward `plannedBySize`. The rest are shown, not counted. */
  garmentLayIds: string[];
  /**
   * True only when every size the cut order asks for is planned in full. A
   * surplus in one size does not make up a shortage in another: nobody ships
   * a spare XL to a customer who ordered a small.
   */
  coversRequirement: boolean;
  /** Pieces missing across the sizes that are short — never offset by surpluses. */
  shortfallTotal: number;
}

/** A panel name that means "the whole garment". An empty panel is read the same way. */
function isWholeGarmentPanel(panel: string | null | undefined): boolean {
  const p = (panel ?? '').trim().toUpperCase();
  return p === '' || p === 'ALL';
}

const normaliseFabric = (f: string | null | undefined): string => (f ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

/**
 * Which lays make garments, and so which lays' pieces count toward the plan.
 *
 * A lay plan lists every lay spread for the order, and not every lay cuts a
 * whole garment. A rib collar in a second fabric, a lining, or a body cut
 * front and back separately all produce pieces that are parts of the same
 * garment as the body lay's. Summing them all counted one shirt two or three
 * times, and a plan that was short could look covered.
 *
 * The rule, kept deliberately conservative:
 *
 *   1. Only the main fabric's lays count. The main fabric is the order's own
 *      fabric when a lay uses it, otherwise the fabric with the most pieces
 *      cut in whole-garment lays (or in any lay, if none are whole-garment).
 *   2. Within the main fabric, a whole-garment lay (panel ALL, or blank)
 *      counts its pieces as garments.
 *   3. When the main fabric has no whole-garment lay at all — the body is
 *      cut panel by panel — a size has as many garments as its scarcest
 *      panel has pieces: a garment needs every one of its panels.
 *
 * Panel lays alongside a whole-garment lay in the main fabric (a separately
 * cut sleeve, say) are left out rather than guessed at: counting them could
 * only overstate the plan.
 */
function garmentOutput(
  results: readonly LayResult[],
  mainFabricHint: string | null | undefined,
): { mainFabric: string | null; garmentLayIds: string[]; plannedBySize: Record<string, number> } {
  if (results.length === 0) return { mainFabric: null, garmentLayIds: [], plannedBySize: {} };

  const fabrics = new Map<string, { name: string; wholePieces: number; anyPieces: number; order: number }>();
  results.forEach((l, i) => {
    const key = normaliseFabric(l.fabric);
    const f = fabrics.get(key) ?? { name: l.fabric, wholePieces: 0, anyPieces: 0, order: i };
    f.anyPieces += l.totalPieces;
    if (isWholeGarmentPanel(l.panel)) f.wholePieces += l.totalPieces;
    fabrics.set(key, f);
  });

  const hint = normaliseFabric(mainFabricHint);
  let mainKey: string;
  if (hint && fabrics.has(hint)) {
    mainKey = hint;
  } else {
    const anyWhole = [...fabrics.values()].some((f) => f.wholePieces > 0);
    const ranked = [...fabrics.entries()].sort(([, a], [, b]) =>
      (anyWhole ? b.wholePieces - a.wholePieces : b.anyPieces - a.anyPieces) || a.order - b.order);
    mainKey = ranked[0]![0];
  }

  const mainLays = results.filter((l) => normaliseFabric(l.fabric) === mainKey);
  const wholeLays = mainLays.filter((l) => isWholeGarmentPanel(l.panel));
  const plannedBySize: Record<string, number> = {};

  if (wholeLays.length > 0) {
    for (const l of wholeLays) {
      for (const [size, qty] of Object.entries(l.output)) plannedBySize[size] = (plannedBySize[size] ?? 0) + qty;
    }
    return { mainFabric: fabrics.get(mainKey)!.name, garmentLayIds: wholeLays.map((l) => l.id), plannedBySize };
  }

  // Cut panel by panel: pieces per panel per size, then the scarcest panel.
  const byPanel = new Map<string, Record<string, number>>();
  for (const l of mainLays) {
    const key = l.panel.trim().toUpperCase();
    const out = byPanel.get(key) ?? {};
    for (const [size, qty] of Object.entries(l.output)) out[size] = (out[size] ?? 0) + qty;
    byPanel.set(key, out);
  }
  const panels = [...byPanel.values()];
  const sizes = new Set(panels.flatMap((p) => Object.keys(p)));
  for (const size of sizes) plannedBySize[size] = Math.min(...panels.map((p) => p[size] ?? 0));
  return { mainFabric: fabrics.get(mainKey)!.name, garmentLayIds: mainLays.map((l) => l.id), plannedBySize };
}

/**
 * Reconcile the lay plan against the cut requirement.
 *
 * For PO A302059B this reproduces the sheet exactly: the plan yields 2,090
 * pieces against a 2,084 requirement (−6 overall), with per-size drift of
 * +2 on 2YXS and −1 on YXS, using 408 layers and 1,194 m of Rosetta.
 */
export function computeMarkerPlan(
  lays: readonly LayInput[],
  requiredBySize: Record<string, number>,
  options: { mainFabric?: string | null } = {},
): MarkerPlanSummary {
  const results = lays.map(computeLay);

  const { mainFabric, garmentLayIds, plannedBySize } = garmentOutput(results, options.mainFabric);

  const allSizes = new Set([...Object.keys(plannedBySize), ...Object.keys(requiredBySize)]);
  const varianceBySize: Record<string, number> = {};
  for (const s of allSizes) varianceBySize[s] = (plannedBySize[s] ?? 0) - (requiredBySize[s] ?? 0);
  const shortfallTotal = sum(Object.values(varianceBySize).map((v) => (v < 0 ? -v : 0)));

  const plannedTotal = sum(Object.values(plannedBySize));
  const requiredTotal = sum(Object.values(requiredBySize));
  const totalFabricM = sum(results.map((l) => l.totalLengthM));
  const theoreticalFabricM = sum(results.map((l) => l.theoreticalLengthM));

  return {
    lays: results,
    theoreticalFabricM,
    allowanceM: totalFabricM - theoreticalFabricM,
    allowancePct: safePct(totalFabricM - theoreticalFabricM, theoreticalFabricM),
    plannedBySize,
    plannedTotal,
    requiredBySize,
    requiredTotal,
    varianceBySize,
    varianceTotal: plannedTotal - requiredTotal,
    totalLayers: sum(results.map((l) => l.layers)),
    totalFabricM,
    avgConsumptionPerPieceM: safeDiv(totalFabricM, plannedTotal),
    planEfficiencyPct: safePct(requiredTotal, plannedTotal),
    mainFabric,
    garmentLayIds,
    // Whether an empty requirement counts as covered is the caller's call —
    // the step and the gate have always answered it differently.
    coversRequirement: shortfallTotal === 0,
    shortfallTotal,
  };
}

/** Fabric position: required vs available vs issued vs consumed. */
export interface FabricPosition {
  fabric: string;
  color: string;
  requiredM: number;
  availableM: number | null;
  issuedM: number | null;
  actualConsumptionM: number | null;
  remainingM: number | null;
  shortageM: number;
  consumptionVsPlanPct: number | null;
}

export function computeFabricPosition(i: {
  fabric: string; color: string; requiredM: number;
  availableM?: number | null; issuedM?: number | null; actualConsumptionM?: number | null;
}): FabricPosition {
  const issued = i.issuedM ?? null;
  const consumed = i.actualConsumptionM ?? null;
  return {
    fabric: i.fabric,
    color: i.color,
    requiredM: i.requiredM,
    availableM: i.availableM ?? null,
    issuedM: issued,
    actualConsumptionM: consumed,
    remainingM: issued != null && consumed != null ? issued - consumed : null,
    shortageM: Math.max(0, i.requiredM - (issued ?? 0)),
    consumptionVsPlanPct: safePct(consumed, i.requiredM),
  };
}
