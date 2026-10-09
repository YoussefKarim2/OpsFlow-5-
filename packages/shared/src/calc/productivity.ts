/**
 * Factory-wide productivity — Phase 1.
 *
 * Everything here is an aggregation of records the application already keeps.
 * Nothing is estimated: a figure the data cannot support is `null`, and the
 * reason is reported next to it, so the screen can say "not recorded" instead
 * of showing a zero that nobody entered.
 *
 * Zero versus missing, precisely:
 *
 *   An operation on a day is a NUMBER when at least one production record for
 *   that operation exists on that day — the sum, which may legitimately be 0,
 *   because a zero-quantity record is accepted by the production endpoint and
 *   is how the floor says "we ran and made nothing".
 *
 *   It is NULL when no record for that operation exists on that day. The
 *   application has no way to know whether the line stood idle or whether
 *   nobody filled the sheet in, so it does not pretend to.
 *
 *   A day is "recorded" when any operation has a record. Rates are averaged
 *   over recorded days, never calendar days: a Friday off must not read as a
 *   slow Friday.
 *
 * Days are calendar days in UTC. Production dates are stored at UTC midnight
 * from a `YYYY-MM-DD` input, so this is the same calendar the rest of the
 * application uses (`fmtDate` renders in UTC for the same reason).
 */

import { ProductionOperation } from '../enums.js';
import { safeDiv, safePct, sum } from './num.js';

// ── Date range ──────────────────────────────────────────────────────────────

/** A closed range of calendar days, `YYYY-MM-DD` both ends. */
export interface DayRange {
  from: string;
  to: string;
}

const MS_PER_DAY = 86_400_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_KEY.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The calendar day a timestamp falls on, in UTC. */
export function dayKeyOf(value: string | Date): string {
  return new Date(value).toISOString().slice(0, 10);
}

function dayToMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function shiftDay(day: string, days: number): string {
  return new Date(dayToMs(day) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Number of calendar days in a closed range; 1 for a single day. */
export function daysInRange(range: DayRange): number {
  return Math.round((dayToMs(range.to) - dayToMs(range.from)) / MS_PER_DAY) + 1;
}

/** Every day in the range, ascending. */
export function enumerateDays(range: DayRange): string[] {
  const out: string[] = [];
  const n = daysInRange(range);
  for (let i = 0; i < n; i++) out.push(shiftDay(range.from, i));
  return out;
}

/**
 * The same number of days immediately before the range, for the trend. A
 * seven-day week compares with the seven days before it; a month with the
 * same number of days before its first day, not with "last month", so the
 * comparison is always like for like.
 */
export function previousRange(range: DayRange): DayRange {
  const n = daysInRange(range);
  return { from: shiftDay(range.from, -n), to: shiftDay(range.from, -1) };
}

/**
 * The half-open UTC instant bounds for a database query: `[start, end)`.
 * A record at 23:59:59 on the last day is inside; midnight the next day is not.
 */
export function rangeBounds(range: DayRange): { start: Date; end: Date } {
  return { start: new Date(dayToMs(range.from)), end: new Date(dayToMs(range.to) + MS_PER_DAY) };
}

export type ProductivityPeriod = 'day' | 'week' | 'month';

/**
 * The range a period preset selects around an anchor day. Weeks run Monday to
 * Sunday. `anchor` is a `YYYY-MM-DD` day in the calendar the user is looking at.
 */
export function periodRange(period: ProductivityPeriod, anchor: string): DayRange {
  const d = new Date(dayToMs(anchor));
  switch (period) {
    case 'day':
      return { from: anchor, to: anchor };
    case 'week': {
      // getUTCDay: Sunday 0 … Saturday 6. Shift so Monday is the start.
      const offset = (d.getUTCDay() + 6) % 7;
      const from = shiftDay(anchor, -offset);
      return { from, to: shiftDay(from, 6) };
    }
    case 'month': {
      const y = d.getUTCFullYear(), m = d.getUTCMonth();
      const from = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
      const to = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
      return { from, to };
    }
  }
}

// ── Output ──────────────────────────────────────────────────────────────────

export const PRODUCTION_OPERATIONS: readonly ProductionOperation[] = [
  ProductionOperation.CUTTING, ProductionOperation.SEWING, ProductionOperation.PRINTING,
  ProductionOperation.EMBROIDERY, ProductionOperation.WASHING, ProductionOperation.FINISHING,
  ProductionOperation.PACKING,
];

/** The operation whose output is the factory's throughput. */
export const PRIMARY_OPERATION: ProductionOperation = ProductionOperation.SEWING;

/**
 * The operations a person can pick as the primary one. Washing and finishing
 * are not stages this factory manages by, so they are not offered. They stay
 * in the enum and in `PRODUCTION_OPERATIONS`: a record already filed under
 * them must still be counted and shown.
 */
export const PRIMARY_OPERATION_CHOICES: readonly ProductionOperation[] = [
  ProductionOperation.CUTTING, ProductionOperation.SEWING, ProductionOperation.PRINTING,
  ProductionOperation.EMBROIDERY, ProductionOperation.PACKING,
];

/**
 * Operations in the order a garment meets them. Used to lay out stage
 * throughput so the reader sees pieces flowing left to right, which is also
 * why those columns must never be summed: it is the same garment at each one.
 */
export const STAGE_ORDER: readonly ProductionOperation[] = [
  ProductionOperation.CUTTING, ProductionOperation.PRINTING, ProductionOperation.EMBROIDERY,
  ProductionOperation.SEWING, ProductionOperation.WASHING, ProductionOperation.FINISHING,
  ProductionOperation.PACKING,
];

export interface ProductivityRecordInput {
  id: string;
  orderId: string;
  date: string | Date;
  operation: ProductionOperation;
  qty: number;
  line?: string | null;
  team?: string | null;
}

/** Output per operation on one day. `null` = no record for that operation. */
export type OperationOutput = Record<ProductionOperation, number | null>;

export interface DayOutput {
  date: string;
  /** True when any operation has a record on this day. */
  recorded: boolean;
  byOperation: OperationOutput;
  /** The primary operation's output: a number when recorded, else null. */
  primary: number | null;
  recordCount: number;
  /** Distinct orders with any production record on this day. */
  orderCount: number;
}

export interface OperationSummary {
  operation: ProductionOperation;
  /** Sum over the days this operation was recorded; null when it never was. */
  qty: number | null;
  recordedDays: number;
  /** qty ÷ recordedDays. Null when the operation was never recorded. */
  avgPerRecordedDay: number | null;
}

export interface OutputSummary {
  range: DayRange;
  calendarDays: number;
  /** Days with at least one production record of any operation. */
  recordedDays: number;
  /** Days with no production record at all — unknown, not zero. */
  unrecordedDays: number;
  /** Primary-operation total over the days it was recorded. Null if never. */
  primaryQty: number | null;
  /** Days on which the primary operation was recorded. */
  primaryRecordedDays: number;
  primaryAvgPerRecordedDay: number | null;
  primaryPeakDay: { date: string; qty: number } | null;
  byOperation: OperationSummary[];
  days: DayOutput[];
}

function emptyOperationOutput(): OperationOutput {
  return Object.fromEntries(PRODUCTION_OPERATIONS.map((op) => [op, null])) as OperationOutput;
}

/**
 * Collapse production records into one row per calendar day of the range.
 * Records outside the range are ignored, so a caller that over-fetched is
 * still correct.
 */
export function summariseOutput(
  records: readonly ProductivityRecordInput[],
  range: DayRange,
  primary: ProductionOperation = PRIMARY_OPERATION,
): OutputSummary {
  const byDay = new Map<string, { byOperation: OperationOutput; records: number; orders: Set<string> }>();
  for (const day of enumerateDays(range)) {
    byDay.set(day, { byOperation: emptyOperationOutput(), records: 0, orders: new Set() });
  }

  for (const r of records) {
    const key = dayKeyOf(r.date);
    const bucket = byDay.get(key);
    if (!bucket) continue; // outside the range
    if (!Number.isFinite(r.qty)) continue;
    bucket.byOperation[r.operation] = (bucket.byOperation[r.operation] ?? 0) + r.qty;
    bucket.records += 1;
    bucket.orders.add(r.orderId);
  }

  const days: DayOutput[] = [...byDay.entries()].map(([date, b]) => ({
    date,
    recorded: b.records > 0,
    byOperation: b.byOperation,
    primary: b.byOperation[primary],
    recordCount: b.records,
    orderCount: b.orders.size,
  }));

  const byOperation: OperationSummary[] = PRODUCTION_OPERATIONS.map((operation) => {
    const recordedDays = days.filter((d) => d.byOperation[operation] != null);
    const qty = recordedDays.length > 0 ? sum(recordedDays.map((d) => d.byOperation[operation])) : null;
    return {
      operation,
      qty,
      recordedDays: recordedDays.length,
      avgPerRecordedDay: recordedDays.length > 0 ? safeDiv(qty, recordedDays.length) : null,
    };
  });

  const primaryDays = days.filter((d) => d.primary != null);
  const primaryQty = primaryDays.length > 0 ? sum(primaryDays.map((d) => d.primary)) : null;
  let primaryPeakDay: OutputSummary['primaryPeakDay'] = null;
  for (const d of primaryDays) {
    if (primaryPeakDay == null || d.primary! > primaryPeakDay.qty) primaryPeakDay = { date: d.date, qty: d.primary! };
  }

  const recordedDays = days.filter((d) => d.recorded).length;
  return {
    range,
    calendarDays: days.length,
    recordedDays,
    unrecordedDays: days.length - recordedDays,
    primaryQty,
    primaryRecordedDays: primaryDays.length,
    primaryAvgPerRecordedDay: primaryDays.length > 0 ? safeDiv(primaryQty, primaryDays.length) : null,
    primaryPeakDay,
    byOperation,
    days,
  };
}

// ── Trend ───────────────────────────────────────────────────────────────────

export interface Trend {
  current: number | null;
  previous: number | null;
  /** (current − previous) ÷ previous × 100. Null unless both sides have data. */
  changePct: number | null;
  /** Why there is no comparison, when there is none. */
  reason: 'NO_CURRENT' | 'NO_PREVIOUS' | 'PREVIOUS_ZERO' | null;
}

/**
 * Compare two figures. The comparison is between like quantities only: a
 * total with a total, an average with an average. Callers compare averages
 * per recorded day, so a week with three recorded days is not read as a
 * collapse against a week with five.
 */
export function compareTrend(current: number | null, previous: number | null): Trend {
  if (current == null) return { current, previous, changePct: null, reason: 'NO_CURRENT' };
  if (previous == null) return { current, previous, changePct: null, reason: 'NO_PREVIOUS' };
  if (previous === 0) return { current, previous, changePct: null, reason: 'PREVIOUS_ZERO' };
  return { current, previous, changePct: safePct(current - previous, previous), reason: null };
}

// ── Defect rate ─────────────────────────────────────────────────────────────
//
// An audit records defects by category, and the stored "rejected" figure on an
// audit is the total of those counts (see computeAudit: rejectedQty =
// totalDefects). That is a count of DEFECTS, not of defective PIECES — a piece
// with a stitching fault and a stain contributes two. The application does not
// record how many pieces were defective, so a true reject rate (defective
// pieces ÷ pieces inspected) cannot be given. What can be given, and what the
// Quality tab itself calls "Defect rate", is defects per hundred pieces
// inspected. It is named that here so nobody reads it as a share of pieces.

export interface ProductivityAuditInput {
  id: string;
  orderId: string;
  inspectionDate: string | Date;
  /** Pieces inspected. Null when neither recorded nor derivable from AQL. */
  sampleSize: number | null;
  /** Defects found in the sample — occurrences, not defective pieces. */
  defectQty: number | null;
  result: 'PASS' | 'FAIL' | 'PENDING';
}

export interface DefectRateSummary {
  /** Σ defects ÷ Σ pieces inspected × 100: defects per hundred pieces inspected. */
  defectRatePct: number | null;
  auditCount: number;
  /** Audits that contributed to the rate. */
  countedAudits: number;
  /** Audits in the range without a sample size or defect count — excluded, not guessed. */
  excludedAudits: number;
  sampleQty: number;
  defectQty: number;
  failedCount: number;
  pendingCount: number;
  /** Set when the rate cannot be given. */
  reason: 'NO_AUDITS' | 'NO_COUNTABLE_AUDITS' | null;
}

export function summariseDefectRate(
  audits: readonly ProductivityAuditInput[],
  range: DayRange,
): DefectRateSummary {
  const days = new Set(enumerateDays(range));
  const inRange = audits.filter((a) => days.has(dayKeyOf(a.inspectionDate)));
  const countable = inRange.filter(
    (a) => a.sampleSize != null && a.sampleSize > 0 && a.defectQty != null && Number.isFinite(a.defectQty),
  );
  const sampleQty = sum(countable.map((a) => a.sampleSize));
  const defectQty = sum(countable.map((a) => a.defectQty));

  return {
    defectRatePct: countable.length > 0 ? safePct(defectQty, sampleQty) : null,
    auditCount: inRange.length,
    countedAudits: countable.length,
    excludedAudits: inRange.length - countable.length,
    sampleQty,
    defectQty,
    failedCount: inRange.filter((a) => a.result === 'FAIL').length,
    pendingCount: inRange.filter((a) => a.result === 'PENDING').length,
    reason: inRange.length === 0 ? 'NO_AUDITS' : countable.length === 0 ? 'NO_COUNTABLE_AUDITS' : null,
  };
}

// ── Fabric utilisation ──────────────────────────────────────────────────────

export interface ProductivityCuttingInput {
  id: string;
  orderId: string;
  /** Null when the record carries no date — it cannot be placed in a period. */
  cutDate: string | Date | null;
  actualCutQty: number | null;
  fabricUsedM: number | null;
}

export interface FabricUtilisationSummary {
  /** Σ fabric used ÷ Σ pieces cut, over records with both figures and a date. */
  metresPerPiece: number | null;
  recordCount: number;
  countedRecords: number;
  /** Dated records in the range missing the metres or the pieces — excluded. */
  excludedRecords: number;
  piecesCut: number;
  fabricUsedM: number;
  reason: 'NO_RECORDS' | 'NO_COUNTABLE_RECORDS' | null;
}

export function summariseFabricUtilisation(
  records: readonly ProductivityCuttingInput[],
  range: DayRange,
): FabricUtilisationSummary {
  const days = new Set(enumerateDays(range));
  const inRange = records.filter((r) => r.cutDate != null && days.has(dayKeyOf(r.cutDate)));
  const countable = inRange.filter(
    (r) => r.actualCutQty != null && r.actualCutQty > 0 && r.fabricUsedM != null && r.fabricUsedM >= 0,
  );
  const piecesCut = sum(countable.map((r) => r.actualCutQty));
  const fabricUsedM = sum(countable.map((r) => r.fabricUsedM));

  return {
    metresPerPiece: countable.length > 0 ? safeDiv(fabricUsedM, piecesCut) : null,
    recordCount: inRange.length,
    countedRecords: countable.length,
    excludedRecords: inRange.length - countable.length,
    piecesCut,
    fabricUsedM,
    reason: inRange.length === 0 ? 'NO_RECORDS' : countable.length === 0 ? 'NO_COUNTABLE_RECORDS' : null,
  };
}

// ── Per-order breakdown (drill-down) ────────────────────────────────────────

export interface OrderOutputRow {
  orderId: string;
  /** Output per operation over the range; null when never recorded. */
  byOperation: OperationOutput;
  primary: number | null;
  recordedDays: number;
  recordCount: number;
}

/** What each order contributed over the range, primary operation first. */
export function summariseByOrder(
  records: readonly ProductivityRecordInput[],
  range: DayRange,
  primary: ProductionOperation = PRIMARY_OPERATION,
): OrderOutputRow[] {
  const days = new Set(enumerateDays(range));
  const map = new Map<string, { byOperation: OperationOutput; days: Set<string>; records: number }>();
  for (const r of records) {
    const key = dayKeyOf(r.date);
    if (!days.has(key) || !Number.isFinite(r.qty)) continue;
    const cur = map.get(r.orderId) ?? { byOperation: emptyOperationOutput(), days: new Set<string>(), records: 0 };
    cur.byOperation[r.operation] = (cur.byOperation[r.operation] ?? 0) + r.qty;
    cur.days.add(key);
    cur.records += 1;
    map.set(r.orderId, cur);
  }
  return [...map.entries()]
    .map(([orderId, v]) => ({
      orderId,
      byOperation: v.byOperation,
      primary: v.byOperation[primary],
      recordedDays: v.days.size,
      recordCount: v.records,
    }))
    .sort((a, b) => (b.primary ?? -1) - (a.primary ?? -1) || b.recordCount - a.recordCount);
}

// ── Factory overview ────────────────────────────────────────────────────────
//
// The whole factory for a period, from the same production records. A record
// is pieces passing through ONE operation, and a garment passes through
// several, so quantities are never added across operations: that would count
// one garment up to five times. The overview gives three separate things and
// names each for what it is.
//
//   Garments sewn — the unique output. Sewing is where a garment comes into
//   being, and it is already what "produced" means on every order page.
//
//   Garments packed — finished goods, the same garments counted again at the
//   last stage. Kept apart from sewn because packing lags sewing and a period
//   boundary can fall between the two.
//
//   Stage throughput — pieces through each operation, in manufacturing order.
//   Shown side by side, never totalled.

export interface StageThroughput {
  operation: ProductionOperation;
  /** Pieces through this stage over the days it was recorded; null if never. */
  qty: number | null;
  recordedDays: number;
  avgPerRecordedDay: number | null;
  /** Whether any record for this operation exists in the period. */
  recorded: boolean;
}

export interface FactoryOverview {
  range: DayRange;
  calendarDays: number;
  recordedDays: number;
  unrecordedDays: number;
  recordCount: number;
  /** Distinct orders with any production record in the period. */
  activeOrders: number;
  /** Unique garments made: sewing output over the days sewing was recorded. */
  garmentsSewn: number | null;
  sewnRecordedDays: number;
  sewnPerRecordedDay: number | null;
  /** Finished goods: packing output. The same garments, later. Never added to sewn. */
  garmentsPacked: number | null;
  packedRecordedDays: number;
  /** Every operation in manufacturing order, recorded or not. */
  stages: StageThroughput[];
  operationsRecorded: ProductionOperation[];
  operationsUnrecorded: ProductionOperation[];
  /** One row per calendar day, each operation null when not recorded that day. */
  days: DayOutput[];
}

export function summariseFactory(
  records: readonly ProductivityRecordInput[],
  range: DayRange,
): FactoryOverview {
  const out = summariseOutput(records, range, ProductionOperation.SEWING);
  const byOp = new Map(out.byOperation.map((o) => [o.operation, o]));
  const stages: StageThroughput[] = STAGE_ORDER.map((operation) => {
    const o = byOp.get(operation)!;
    return { operation, qty: o.qty, recordedDays: o.recordedDays, avgPerRecordedDay: o.avgPerRecordedDay, recorded: o.recordedDays > 0 };
  });
  const sewing = byOp.get(ProductionOperation.SEWING)!;
  const packing = byOp.get(ProductionOperation.PACKING)!;

  const days = new Set(enumerateDays(range));
  const orders = new Set<string>();
  let recordCount = 0;
  for (const r of records) {
    if (!days.has(dayKeyOf(r.date)) || !Number.isFinite(r.qty)) continue;
    orders.add(r.orderId);
    recordCount += 1;
  }

  return {
    range,
    calendarDays: out.calendarDays,
    recordedDays: out.recordedDays,
    unrecordedDays: out.unrecordedDays,
    recordCount,
    activeOrders: orders.size,
    garmentsSewn: sewing.qty,
    sewnRecordedDays: sewing.recordedDays,
    sewnPerRecordedDay: sewing.avgPerRecordedDay,
    garmentsPacked: packing.qty,
    packedRecordedDays: packing.recordedDays,
    stages,
    operationsRecorded: stages.filter((s) => s.recorded).map((s) => s.operation),
    operationsUnrecorded: stages.filter((s) => !s.recorded).map((s) => s.operation),
    days: out.days,
  };
}
