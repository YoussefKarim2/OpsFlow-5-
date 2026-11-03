/**
 * A field at least as wide as what it holds.
 *
 * A table sizes its columns to the widest thing in them, and an input's width
 * is not its text — so without this, a wide neighbour squeezed a figure to
 * "70." of 70.20, and a colour to "COLUMBIA/" of COLUMBIA/WH. Given as a
 * minimum, the column grows to fit instead.
 */

/**
 * How wide a text is, in `ch` (the width of a "0"): capitals count wider and
 * narrow letters narrower, so "LIME/BLACK" is not cut off.
 */
export function textWidth(t: string | null | undefined): number {
  let w = 0;
  for (const ch of t ?? '') w += /[A-Z@%&#]/.test(ch) ? (/[MW]/.test(ch) ? 1.7 : /[I]/.test(ch) ? 0.7 : 1.4) : /[iljtf.,:;'|!() /]/.test(ch) ? 0.6 : /[mw]/.test(ch) ? 1.4 : 1;
  // A "0" is wider than the average letter of this typeface.
  return w * 0.85;
}

/** `min` and the text in `ch`; `pad` is the box's own padding and border. */
export const fitWidth = (text: string | null | undefined, min = 5, pad = '1.25rem'): { minWidth: string } =>
  ({ minWidth: `calc(${Math.ceil(Math.max(min, textWidth(text), (text ?? '').length * 0.6)) + 1}ch + ${pad})` });
