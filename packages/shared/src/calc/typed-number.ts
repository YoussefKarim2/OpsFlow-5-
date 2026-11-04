/**
 * Reading a figure a person typed, without guessing.
 *
 * A comma is read one way only: as a thousands separator, in the places one
 * goes ("1,000", "12,345.50"). "7,25" is refused rather than read as 725 or as
 * 7.25 — either guess is a wrong figure saved without anyone noticing, and the
 * person who typed it is right there to say which they meant.
 */

export type TypedNumber =
  | { ok: true; value: number | null }
  | { ok: false; reason: string };

const PLAIN = /^-?(\d+\.?\d*|\.\d+)$/;
const THOUSANDS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;

/** Blank is no value; a readable figure is its number; anything else is refused with a reason. */
export function readTypedNumber(text: string): TypedNumber {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  let n: number | null = null;
  if (PLAIN.test(t)) n = Number(t);
  else if (THOUSANDS.test(t)) n = Number(t.replace(/,/g, ''));
  if (n != null && Number.isFinite(n)) return { ok: true, value: n };
  if (t.includes(',')) {
    return { ok: false, reason: `“${t}” is not readable: use a point for decimals (7.25), and a comma only between thousands (1,000).` };
  }
  return { ok: false, reason: `“${t}” is not a number.` };
}

/** The figure, or null when the field is blank or unreadable (check `readTypedNumber` before saving). */
export function typedNumberOrNull(text: string): number | null {
  const r = readTypedNumber(text);
  return r.ok ? r.value : null;
}

/**
 * Whether a figure field should accept this keystroke: digits, one point, a
 * leading minus, and commas (so "1,000" can be typed). Half-finished figures
 * pass; whether the result is readable is `readTypedNumber`'s question.
 */
export function isTypeableFigure(text: string): boolean {
  return text === '' || /^\s*-?[\d,]*\.?\d*\s*$/.test(text);
}
