/**
 * Today as the factory's calendar has it, stored the way a typed date is.
 *
 * The screens send a picked date as `2026-10-27`, which becomes midnight UTC on
 * that day. A default stamped with `new Date()` instead is the instant itself,
 * and Cairo is two or three hours ahead of UTC: an audit recorded at 01:30 on
 * the 28th was stored as the evening of the 27th and counted on the wrong day.
 * So a default is the Cairo calendar day, at UTC midnight, exactly as if
 * someone had picked it.
 */

const CAIRO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** The Cairo calendar day of `now`, as a Date at 00:00 UTC on that day. */
export function cairoDay(now: Date = new Date()): Date {
  // en-CA formats as YYYY-MM-DD; reading the parts keeps it independent of that.
  const parts = Object.fromEntries(CAIRO_DAY.formatToParts(now).map((p) => [p.type, p.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}
