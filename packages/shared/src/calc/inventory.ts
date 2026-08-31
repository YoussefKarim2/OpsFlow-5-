/**
 * Inventory engine.
 *
 * The rule this file exists to enforce is that **stock has four states, not one
 * number**. A factory that tracks a single "quantity" cannot answer the only
 * question that matters at eight in the morning — *can I cut this order today?*
 * — because the metres on the shelf may already be spoken for by a different
 * order that starts tomorrow.
 *
 *     Physical    what is on the shelf, the sum of the movement ledger
 *     Reserved    committed to confirmed orders, still on the shelf
 *     Available   physical − reserved: what a new order may actually take
 *     Consumed    issued to production and gone
 *
 * Of these, only `physical` is a stored balance (and only as a running total
 * behind the append-only movement ledger, which stays authoritative — see
 * `reconcileStock` on the server). `reserved`, `available` and every shortage
 * are computed here, at read time, from their inputs. A stored shortage is a
 * shortage that can disagree with the stock it was calculated from.
 *
 * All arithmetic goes through `qtyAdd`/`qtySub`/`qtyCmp`, which work in integer
 * space at four decimal places. Fabric is measured in metres to three decimals
 * and a plain `+=` loop over a few hundred movements drifts.
 */

import { MovementType, StockStatus, UnitOfMeasure } from '../enums.js';
import { qtyAdd, qtySub, qtyCmp, quantise, safeDiv, safePct } from './num.js';

// ─────────────────────────────────────────────────────────────────────────────
// Units
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Conversion factors to each dimension's base unit.
 *
 * Conversion is deliberately *not* implicit anywhere else in the system. A BOM
 * line in yards and a stock balance in metres are not silently reconciled;
 * `convertQty` returns null across dimensions, and the caller has to decide.
 * The alternative — quietly treating 100 pieces as 100 kilos because both are
 * "a number" — is the kind of error that reaches the cutting floor.
 */
const UNIT_BASE: Partial<Record<UnitOfMeasure, { dimension: string; factor: number }>> = {
  M:    { dimension: 'length', factor: 1 },
  CM:   { dimension: 'length', factor: 0.01 },
  YD:   { dimension: 'length', factor: 0.9144 },
  KG:   { dimension: 'mass',   factor: 1 },
  G:    { dimension: 'mass',   factor: 0.001 },
  PCS:  { dimension: 'count',  factor: 1 },
  DZN:  { dimension: 'count',  factor: 12 },
  L:    { dimension: 'volume', factor: 1 },
};

/**
 * How units are spelled in the wild.
 *
 * The source workbook writes metres as "Met." and pieces as "Pcs"; a supplier
 * invoice writes "MTR" and "PC"; a customer writes "meters". They are all the
 * same unit, and a system that treats them as different silently refuses to
 * compare a requirement with the stock that satisfies it.
 *
 * This is spelling, not conversion. Genuinely different units still go through
 * `convertQty`, which can refuse.
 */
const UNIT_ALIASES: Record<string, UnitOfMeasure> = {
  M: 'M', MT: 'M', MTR: 'M', MTS: 'M', MET: 'M', METER: 'M', METERS: 'M',
  METRE: 'M', METRES: 'M', MTRS: 'M', LM: 'M',
  CM: 'CM', CMS: 'CM', CENTIMETER: 'CM', CENTIMETRE: 'CM',
  YD: 'YD', YDS: 'YD', YARD: 'YD', YARDS: 'YD',
  KG: 'KG', KGS: 'KG', KILO: 'KG', KILOS: 'KG', KILOGRAM: 'KG', KILOGRAMS: 'KG',
  G: 'G', GR: 'G', GM: 'G', GRAM: 'G', GRAMS: 'G',
  PCS: 'PCS', PC: 'PCS', PIECE: 'PCS', PIECES: 'PCS', EA: 'PCS', EACH: 'PCS', NO: 'PCS', UNIT: 'PCS', UNITS: 'PCS',
  DZN: 'DZN', DZ: 'DZN', DOZ: 'DZN', DOZEN: 'DZN', DOZENS: 'DZN',
  ROLL: 'ROLL', ROLLS: 'ROLL',
  CONE: 'CONE', CONES: 'CONE',
  SET: 'SET', SETS: 'SET',
  BOX: 'BOX', BOXES: 'BOX', CTN: 'BOX', CARTON: 'BOX', CARTONS: 'BOX',
  L: 'L', LTR: 'L', LITRE: 'L', LITER: 'L', LITRES: 'L', LITERS: 'L',
};

/**
 * Resolve a unit as written to a canonical one, or null when it is not
 * recognised. Punctuation and case are stripped: "Met.", "met", "MET" all
 * resolve to M.
 */
export function normaliseUnit(raw: string | null | undefined): UnitOfMeasure | null {
  if (!raw) return null;
  const key = raw.toUpperCase().replace(/[^A-Z]/g, '');
  return UNIT_ALIASES[key] ?? null;
}

/**
 * Convert between compatible units. Returns null when the units belong to
 * different dimensions, or when either is a packaging unit (ROLL, CONE, BOX,
 * SET) whose size varies by supplier and cannot be assumed.
 */
export function convertQty(
  qty: number,
  from: string,
  to: string,
): number | null {
  const a = normaliseUnit(from);
  const b = normaliseUnit(to);
  if (a && b && a === b) return quantise(qty);
  if (!a || !b) return from === to ? quantise(qty) : null;

  const x = UNIT_BASE[a];
  const y = UNIT_BASE[b];
  if (!x || !y || x.dimension !== y.dimension) return null;
  return quantise((qty * x.factor) / y.factor);
}

/** True when two units can be compared without a conversion decision. */
export function unitsCompatible(a: string, b: string): boolean {
  const x = normaliseUnit(a);
  const y = normaliseUnit(b);
  if (x && y && x === y) return true;
  if (!x || !y) return a === b;
  const dx = UNIT_BASE[x];
  const dy = UNIT_BASE[y];
  return !!dx && !!dy && dx.dimension === dy.dimension;
}

// ─────────────────────────────────────────────────────────────────────────────
// Movements → physical balance
// ─────────────────────────────────────────────────────────────────────────────

export interface MovementInput {
  id: string;
  type: MovementType;
  /** Always positive as entered. The direction comes from `type`. */
  qty: number;
  occurredAt: string | Date;
  orderId?: string | null;
  batchLot?: string | null;
}

/**
 * Which way each movement type moves the shelf.
 *
 * RESERVE and RELEASE are deliberately absent: a reservation does not move
 * anything, it only spoken-for-ises it. Treating a reservation as a withdrawal
 * is the classic double-count — the metres leave the balance at reservation and
 * again at issue, and the shelf reads empty while the fabric is still on it.
 */
export const MOVEMENT_SIGN: Record<MovementType, -1 | 0 | 1> = {
  RECEIPT: 1,
  ISSUE: -1,
  RETURN: 1,
  ADJUSTMENT: 1, // signed by the caller; see `signedQty`
  WASTAGE: -1,
  TRANSFER_IN: 1,
  TRANSFER_OUT: -1,
};

/**
 * The signed effect of one movement.
 *
 * An adjustment is the one type that may legitimately be negative — a stock
 * count that found less than the system believed — so its sign is carried in
 * the quantity rather than in the type.
 */
export function signedQty(m: Pick<MovementInput, 'type' | 'qty'>): number {
  if (m.type === MovementType.ADJUSTMENT) return quantise(m.qty);
  return quantise(Math.abs(m.qty) * MOVEMENT_SIGN[m.type]);
}

/** Replay the ledger. This is the definition of physical stock. */
export function replayMovements(movements: readonly MovementInput[]): number {
  return qtyAdd(...movements.map(signedQty));
}

// ─────────────────────────────────────────────────────────────────────────────
// Position: the four states
// ─────────────────────────────────────────────────────────────────────────────

export interface ReservationInput {
  id: string;
  orderId: string;
  qty: number;
  /** Already drawn down against this reservation by issuing. */
  consumedQty: number;
  active: boolean;
}

export interface StockPosition {
  physicalQty: number;
  reservedQty: number;
  availableQty: number;
  /** Total ever issued to production, net of returns. */
  consumedQty: number;
  minimumQty: number | null;
  /** physical − minimum: how far above (or below) the reorder line. */
  headroomQty: number | null;
  status: StockStatus;
  /** Available as a share of the minimum stock level, for the bar. */
  coverPct: number | null;
}

/**
 * Compute a material's position.
 *
 * `reserved` counts only what is still outstanding on each reservation: once
 * 400 of a reserved 1,000 metres have been issued, 400 have physically left the
 * shelf and only 600 are still spoken for. Counting the full 1,000 would hide
 * 400 metres from every other order for the rest of the order's life.
 */
export function computeStockPosition(input: {
  physicalQty: number;
  reservations: readonly ReservationInput[];
  consumedQty?: number;
  minimumQty?: number | null;
}): StockPosition {
  const physicalQty = quantise(input.physicalQty);

  const reservedQty = qtyAdd(
    ...input.reservations
      .filter((r) => r.active)
      .map((r) => Math.max(0, qtySub(r.qty, r.consumedQty))),
  );

  const availableQty = qtySub(physicalQty, reservedQty);
  const minimumQty = input.minimumQty ?? null;

  return {
    physicalQty,
    reservedQty,
    availableQty,
    consumedQty: quantise(input.consumedQty ?? 0),
    minimumQty,
    headroomQty: minimumQty == null ? null : qtySub(physicalQty, minimumQty),
    status: deriveStockStatus(physicalQty, availableQty, minimumQty),
    coverPct: minimumQty == null || minimumQty === 0 ? null : safePct(availableQty, minimumQty),
  };
}

/**
 * The single definition of a material's health, used by the list, the detail
 * page, the dashboard tiles and the alert engine alike.
 *
 * Ordered worst-first, and note that `OVER_RESERVED` outranks `OUT_OF_STOCK`:
 * having promised more than exists is a worse problem than having none, because
 * it means an order somewhere is planned on fabric that will not arrive.
 */
export function deriveStockStatus(
  physicalQty: number,
  availableQty: number,
  minimumQty: number | null,
): StockStatus {
  if (qtyCmp(availableQty, 0) < 0) return StockStatus.OVER_RESERVED;
  if (qtyCmp(physicalQty, 0) <= 0) return StockStatus.OUT_OF_STOCK;
  if (minimumQty != null && qtyCmp(availableQty, minimumQty) < 0) return StockStatus.LOW;
  return StockStatus.OK;
}

export const STOCK_STATUS_STYLE: Record<StockStatus, { label: string; tone: 'red' | 'amber' | 'green' | 'slate'; rank: number }> = {
  OVER_RESERVED: { label: 'Over-reserved', tone: 'red',   rank: 0 },
  OUT_OF_STOCK:  { label: 'Out of stock',  tone: 'red',   rank: 1 },
  LOW:           { label: 'Low',           tone: 'amber', rank: 2 },
  OK:            { label: 'Good',          tone: 'green', rank: 3 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Requirements and shortages
// ─────────────────────────────────────────────────────────────────────────────

export interface RequirementInput {
  /** BOM line or fabric requirement. */
  id: string;
  materialId: string | null;
  materialName: string;
  unit: string;
  /** What the order needs in total. */
  requiredQty: number;
  /** Already reserved against this requirement. */
  reservedQty: number;
  /** Already issued to production against this requirement. */
  issuedQty: number;
  /** The material's available stock, or null when the line is not linked to one. */
  availableQty: number | null;
}

export interface RequirementResult extends RequirementInput {
  /** Still to secure: required − reserved − issued, never negative. */
  outstandingQty: number;
  /** Outstanding that stock cannot currently cover. This is the real shortage. */
  shortQty: number;
  /** Outstanding that stock *can* cover — reservable right now. */
  reservableQty: number;
  coveragePct: number | null;
  status: 'COVERED' | 'RESERVABLE' | 'SHORT' | 'UNLINKED';
}

/**
 * Work out where one requirement stands.
 *
 * The distinction that matters to a coordinator is between "I have not reserved
 * this yet but the stock is sitting there" and "the stock does not exist".
 * The first is a click; the second is a purchase order and a phone call. They
 * are separate outcomes here rather than one undifferentiated "shortage".
 */
export function computeRequirement(r: RequirementInput): RequirementResult {
  const secured = qtyAdd(r.reservedQty, r.issuedQty);
  const outstandingQty = Math.max(0, qtySub(r.requiredQty, secured));

  // A line with no material record cannot be checked against stock. Saying so
  // is honest; treating it as covered would be a lie the cutting floor finds out.
  if (r.materialId == null || r.availableQty == null) {
    return {
      ...r,
      outstandingQty,
      shortQty: 0,
      reservableQty: 0,
      coveragePct: safePct(secured, r.requiredQty),
      status: outstandingQty === 0 ? 'COVERED' : 'UNLINKED',
    };
  }

  const reservableQty = Math.max(0, Math.min(outstandingQty, r.availableQty));
  const shortQty = Math.max(0, qtySub(outstandingQty, r.availableQty));

  return {
    ...r,
    outstandingQty,
    shortQty,
    reservableQty,
    coveragePct: safePct(secured, r.requiredQty),
    status:
      outstandingQty === 0 ? 'COVERED'
      : shortQty > 0 ? 'SHORT'
      : 'RESERVABLE',
  };
}

export interface MaterialPosition {
  requirements: RequirementResult[];
  totalRequirements: number;
  shortCount: number;
  reservableCount: number;
  unlinkedCount: number;
  coveredCount: number;
  /** True when nothing is outstanding at all — the gate for cutting. */
  fullySecured: boolean;
  /** True when every outstanding line could be reserved from stock right now. */
  fullyCoverable: boolean;
  overallCoveragePct: number | null;
  /** Worst shortages first, for the overview panel and alerts. */
  topShortages: RequirementResult[];
}

export function computeMaterialPosition(inputs: readonly RequirementInput[]): MaterialPosition {
  const requirements = inputs.map(computeRequirement);
  const short = requirements.filter((r) => r.shortQty > 0);
  const totalRequired = qtyAdd(...requirements.map((r) => r.requiredQty));
  const totalSecured = qtyAdd(
    ...requirements.map((r) => Math.min(qtyAdd(r.reservedQty, r.issuedQty), r.requiredQty)),
  );

  return {
    requirements,
    totalRequirements: requirements.length,
    shortCount: short.length,
    reservableCount: requirements.filter((r) => r.status === 'RESERVABLE').length,
    unlinkedCount: requirements.filter((r) => r.status === 'UNLINKED').length,
    coveredCount: requirements.filter((r) => r.status === 'COVERED').length,
    fullySecured: requirements.length > 0 && requirements.every((r) => r.outstandingQty === 0),
    fullyCoverable: requirements.length > 0 && short.length === 0,
    overallCoveragePct: safePct(totalSecured, totalRequired),
    topShortages: [...short].sort((a, b) => b.shortQty - a.shortQty).slice(0, 5),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Expected vs actual consumption
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsumptionVariance {
  materialName: string;
  unit: string;
  consumptionPerPiece: number | null;
  piecesProduced: number;
  expectedQty: number | null;
  actualQty: number;
  /** actual − expected. Positive means the floor used more than the BOM said. */
  varianceQty: number | null;
  variancePct: number | null;
  /** Beyond the tolerance band, in either direction. */
  isSignificant: boolean;
  direction: 'OVER' | 'UNDER' | 'ON_PLAN' | 'UNKNOWN';
}

/** Default tolerance before a variance is worth a coordinator's attention. */
export const CONSUMPTION_TOLERANCE_PCT = 5;

/**
 * Compare what the BOM said a run should consume against what it actually did.
 *
 * This is the number that catches a mis-cut lay, a bad marker, or a BOM whose
 * consumption-per-piece was optimistic — usually days before the fabric runs
 * out, which is when it would otherwise be discovered.
 */
export function computeConsumptionVariance(i: {
  materialName: string;
  unit: string;
  consumptionPerPiece: number | null;
  piecesProduced: number;
  actualQty: number;
  tolerancePct?: number;
}): ConsumptionVariance {
  const tolerance = i.tolerancePct ?? CONSUMPTION_TOLERANCE_PCT;
  const expectedQty =
    i.consumptionPerPiece == null ? null : quantise(i.consumptionPerPiece * i.piecesProduced);

  if (expectedQty == null) {
    return {
      ...i,
      expectedQty: null,
      varianceQty: null,
      variancePct: null,
      isSignificant: false,
      direction: 'UNKNOWN',
    };
  }

  const varianceQty = qtySub(i.actualQty, expectedQty);
  const variancePct = safePct(varianceQty, expectedQty);
  const magnitude = variancePct == null ? 0 : Math.abs(variancePct);

  return {
    ...i,
    expectedQty,
    varianceQty,
    variancePct,
    isSignificant: magnitude > tolerance,
    direction:
      magnitude <= tolerance ? 'ON_PLAN'
      : varianceQty > 0 ? 'OVER'
      : 'UNDER',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory-wide roll-up
// ─────────────────────────────────────────────────────────────────────────────

export interface InventorySummary {
  totalMaterials: number;
  okCount: number;
  lowCount: number;
  outOfStockCount: number;
  overReservedCount: number;
  /** Materials with at least one active reservation. */
  reservedCount: number;
  /** Sum of physical × unit cost, where a cost is known. */
  totalValue: number | null;
  /** How much of the valued stock is spoken for. */
  reservedValue: number | null;
}

export function summariseInventory(
  rows: ReadonlyArray<{ position: StockPosition; unitCost?: number | null }>,
): InventorySummary {
  const valued = rows.filter((r) => r.unitCost != null);
  return {
    totalMaterials: rows.length,
    okCount: rows.filter((r) => r.position.status === StockStatus.OK).length,
    lowCount: rows.filter((r) => r.position.status === StockStatus.LOW).length,
    outOfStockCount: rows.filter((r) => r.position.status === StockStatus.OUT_OF_STOCK).length,
    overReservedCount: rows.filter((r) => r.position.status === StockStatus.OVER_RESERVED).length,
    reservedCount: rows.filter((r) => r.position.reservedQty > 0).length,
    totalValue: valued.length === 0 ? null
      : quantise(valued.reduce((a, r) => a + r.position.physicalQty * (r.unitCost ?? 0), 0)),
    reservedValue: valued.length === 0 ? null
      : quantise(valued.reduce((a, r) => a + r.position.reservedQty * (r.unitCost ?? 0), 0)),
  };
}

/**
 * How many days of cover the current stock gives at a recent consumption rate.
 * Null rather than Infinity when nothing is being consumed — "no burn rate" is
 * not "infinite cover", and rendering ∞ on a dashboard helps nobody.
 */
export function daysOfCover(availableQty: number, dailyConsumption: number | null): number | null {
  if (dailyConsumption == null || dailyConsumption <= 0) return null;
  const days = safeDiv(availableQty, dailyConsumption);
  return days == null ? null : Math.floor(days);
}
