/**
 * Numeric safety layer.
 *
 * The workbook this replaces currently shows `#DIV/0!` in five costing cells and
 * `#VALUE!` on four sheets. The brief is explicit: never show those. The rule
 * enforced here is that *every* division in the system goes through `safeDiv`,
 * which returns `null` rather than NaN/Infinity, and `null` renders as
 * "Not calculated". A number that reaches a screen is always a real number.
 */

/** Division that cannot produce NaN or Infinity. Returns null when undefined. */
export function safeDiv(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator == null || denominator == null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** Percentage of part within whole, 0–100, or null. */
export function safePct(part: number | null | undefined, whole: number | null | undefined): number | null {
  const r = safeDiv(part, whole);
  return r === null ? null : r * 100;
}

/** Sum that ignores null/undefined/non-finite entries. */
export function sum(values: readonly (number | null | undefined)[]): number {
  let total = 0;
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) total += v;
  return total;
}

/** Excel ROUNDUP(x, 0). Used for the cut quantity, which must never round down. */
export function roundUp(value: number): number {
  return Number.isFinite(value) ? Math.ceil(value) : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Round to n decimal places without float drift artefacts. */
export function round(value: number | null, places = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** places;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/**
 * Quantity precision for inventory arithmetic.
 *
 * Stock is measured in metres, kilos and pieces, and `0.1 + 0.2 !== 0.3` in
 * binary floating point. Left alone, a fabric balance drifts by a fraction of a
 * millimetre per movement and eventually a "zero" balance compares as
 * `-0.0000000001`, which reads as a shortage that is not real.
 *
 * Everything that adds, subtracts or compares a stock quantity goes through
 * these three helpers, and the database column is `Decimal(18,4)` to match.
 * Four places is finer than any real unit of issue and coarse enough that the
 * arithmetic stays exact in integer space.
 */
export const QTY_DP = 4;
const QTY_SCALE = 10 ** QTY_DP;

/** Snap a quantity to the stored precision. The only way a quantity is rounded. */
export function quantise(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.round(value * QTY_SCALE) / QTY_SCALE;
}

/**
 * Add quantities in integer space, so a hundred movements do not accumulate
 * float error. `qtyAdd(0.1, 0.2)` is exactly `0.3`.
 */
export function qtyAdd(...values: readonly (number | null | undefined)[]): number {
  let scaled = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    scaled += Math.round(v * QTY_SCALE);
  }
  return scaled / QTY_SCALE;
}

export function qtySub(a: number | null | undefined, b: number | null | undefined): number {
  return qtyAdd(a, -(b ?? 0));
}

/**
 * Compare two quantities at storage precision.
 * Returns -1, 0 or 1. Use this instead of `<` or `===` on stock figures.
 */
export function qtyCmp(a: number | null | undefined, b: number | null | undefined): -1 | 0 | 1 {
  const d = Math.round((a ?? 0) * QTY_SCALE) - Math.round((b ?? 0) * QTY_SCALE);
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}

/** True when the quantity is zero at storage precision — never `=== 0`. */
export function qtyIsZero(value: number | null | undefined): boolean {
  return Math.round((value ?? 0) * QTY_SCALE) === 0;
}

export const NOT_CALCULATED = 'Not calculated' as const;

/** Format a nullable number for display. Never emits NaN, Infinity or "#DIV/0!". */
export function fmtNumber(
  value: number | null | undefined,
  opts: { places?: number; suffix?: string; fallback?: string } = {},
): string {
  const { places = 0, suffix = '', fallback = NOT_CALCULATED } = opts;
  if (value == null || !Number.isFinite(value)) return fallback;
  return value.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places }) + suffix;
}

export function fmtPct(value: number | null | undefined, places = 0): string {
  return fmtNumber(value, { places, suffix: '%' });
}

export function fmtMoney(value: number | null | undefined, currency = '$', places = 2): string {
  if (value == null || !Number.isFinite(value)) return NOT_CALCULATED;
  const sign = value < 0 ? '-' : '';
  return (
    sign + currency +
    Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })
  );
}

/** Signed variance, e.g. "+14" / "−6" / "0". */
export function fmtVariance(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return NOT_CALCULATED;
  if (value === 0) return '0';
  return (value > 0 ? '+' : '−') + Math.abs(value).toLocaleString('en-US');
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `from` to `to`. Negative when `to` is in the past. */
export function daysBetween(from: Date | string, to: Date | string | null | undefined): number | null {
  if (to == null) return null;
  const a = new Date(from), b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((db - da) / MS_PER_DAY);
}

export function addDays(date: Date | string, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function fmtDate(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function fmtDateShort(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

/** True when the string contains Arabic script — used to set dir="rtl" on free text. */
export function isArabic(text: string | null | undefined): boolean {
  return !!text && /[؀-ۿݐ-ݿ]/.test(text);
}
