/**
 * Production analytics — the brief's sections 18 and 19.
 *
 * Replaces the workbook's `Production Follow up` sheet, which is four columns
 * (ITEM / DAY / DATE / QTY) and one SUM. Everything a coordinator actually
 * needs to know — the rate, whether the rate is enough, and when the order will
 * finish at that rate — was never in the file at all. It is computed here.
 */

import { safeDiv, safePct, daysBetween, addDays } from './num.js';
import { ProductionOperation } from '../enums.js';

export interface ProductionEntry {
  date: string | Date;
  operation: ProductionOperation;
  qty: number;
  line?: string | null;
  team?: string | null;
}

export interface ProductionAnalytics {
  orderQty: number;
  cutQty: number;
  producedQty: number;
  remainingQty: number;
  producedPct: number | null;
  /** Trailing average over the recent working window. null until there is data. */
  dailyRate: number | null;
  /** Best single day, for context on whether the current rate is achievable. */
  peakDailyRate: number | null;
  /** Rate needed from today to hit the required date. */
  requiredDailyRate: number | null;
  /** Days of production left at the current rate. */
  daysToComplete: number | null;
  projectedCompletion: Date | null;
  daysUntilRequired: number | null;
  /** projectedCompletion − requiredDate, in days. Positive = late. */
  slipDays: number | null;
  isBehindSchedule: boolean;
  activeDays: number;
  /** Per-day series for the chart, ascending, cumulative included. */
  series: Array<{ date: string; qty: number; cumulative: number }>;
}

const DEFAULT_WINDOW_DAYS = 7;

function dayKey(d: string | Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Compute the full production picture.
 *
 * `operations` filters which operations count as "produced" — sewing is the
 * throughput constraint in this factory, so it is the default. Cutting is
 * tracked separately in the cut ledger and would otherwise be double-counted.
 */
export function computeProductionAnalytics(input: {
  entries: readonly ProductionEntry[];
  orderQty: number;
  cutQty: number;
  requiredDate?: string | Date | null;
  today?: string | Date;
  windowDays?: number;
  operations?: readonly ProductionOperation[];
}): ProductionAnalytics {
  const {
    entries,
    orderQty,
    cutQty,
    requiredDate = null,
    today = new Date(),
    windowDays = DEFAULT_WINDOW_DAYS,
    operations = [ProductionOperation.SEWING],
  } = input;

  const relevant = entries.filter((e) => operations.includes(e.operation));

  // Collapse to one row per calendar day.
  const byDay = new Map<string, number>();
  for (const e of relevant) {
    const k = dayKey(e.date);
    byDay.set(k, (byDay.get(k) ?? 0) + e.qty);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));

  let running = 0;
  const series = days.map(([date, qty]) => {
    running += qty;
    return { date, qty, cumulative: running };
  });

  const producedQty = running;
  const remainingQty = Math.max(0, orderQty - producedQty);
  const activeDays = days.length;

  // Trailing-window rate. Averaged over *active* days, not calendar days: a
  // Friday off should not make the line look slower than it is.
  const window = days.slice(-windowDays);
  const windowQty = window.reduce((acc, [, q]) => acc + q, 0);
  const dailyRate = window.length > 0 ? safeDiv(windowQty, window.length) : null;
  const peakDailyRate = days.length > 0 ? Math.max(...days.map(([, q]) => q)) : null;

  const daysUntilRequired = requiredDate ? daysBetween(today, requiredDate) : null;

  const requiredDailyRate =
    daysUntilRequired != null && daysUntilRequired > 0 ? safeDiv(remainingQty, daysUntilRequired) : null;

  let daysToComplete: number | null = null;
  let projectedCompletion: Date | null = null;
  if (remainingQty === 0) {
    daysToComplete = 0;
    projectedCompletion = days.length > 0 ? new Date(days[days.length - 1]![0]) : null;
  } else if (dailyRate != null && dailyRate > 0) {
    daysToComplete = Math.ceil(remainingQty / dailyRate);
    projectedCompletion = addDays(today, daysToComplete);
  }

  const slipDays =
    projectedCompletion && requiredDate ? daysBetween(requiredDate, projectedCompletion) : null;

  return {
    orderQty,
    cutQty,
    producedQty,
    remainingQty,
    producedPct: safePct(producedQty, orderQty),
    dailyRate,
    peakDailyRate,
    requiredDailyRate,
    daysToComplete,
    projectedCompletion,
    daysUntilRequired,
    slipDays,
    // Behind schedule when the projection lands after the required date, or when
    // we have a required date, work remaining, and no rate at all to finish it.
    isBehindSchedule:
      (slipDays != null && slipDays > 0) ||
      (remainingQty > 0 && daysUntilRequired != null && daysUntilRequired <= 0),
    activeDays,
    series,
  };
}

/** Breakdown by operation, for the production tab's per-operation bars. */
export function computeOperationTotals(
  entries: readonly ProductionEntry[],
): Array<{ operation: ProductionOperation; qty: number; days: number; avgPerDay: number | null }> {
  const map = new Map<ProductionOperation, { qty: number; days: Set<string> }>();
  for (const e of entries) {
    const cur = map.get(e.operation) ?? { qty: 0, days: new Set<string>() };
    cur.qty += e.qty;
    cur.days.add(dayKey(e.date));
    map.set(e.operation, cur);
  }
  return [...map.entries()]
    .map(([operation, v]) => ({
      operation,
      qty: v.qty,
      days: v.days.size,
      avgPerDay: safeDiv(v.qty, v.days.size),
    }))
    .sort((a, b) => b.qty - a.qty);
}

/** Line-level throughput, for spotting which of the 7 single-needle lines is lagging. */
export function computeLineTotals(
  entries: readonly ProductionEntry[],
): Array<{ line: string; qty: number; days: number; avgPerDay: number | null }> {
  const map = new Map<string, { qty: number; days: Set<string> }>();
  for (const e of entries) {
    const line = e.line?.trim() || 'Unassigned';
    const cur = map.get(line) ?? { qty: 0, days: new Set<string>() };
    cur.qty += e.qty;
    cur.days.add(dayKey(e.date));
    map.set(line, cur);
  }
  return [...map.entries()]
    .map(([line, v]) => ({ line, qty: v.qty, days: v.days.size, avgPerDay: safeDiv(v.qty, v.days.size) }))
    .sort((a, b) => b.qty - a.qty);
}
