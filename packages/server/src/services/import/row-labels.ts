/**
 * What a row's label says the row is, shared by every reader.
 *
 * Two questions the readers each answered their own way, and wrongly in
 * opposite directions: whether a label is the table's own total ("Total:",
 * "Subtotal", "Navy Total"), and whether it is a line of the grid that is not
 * a colour at all ("Ratio", "Prepack", "Price"). Nike sells colours called
 * "Total Orange" and "Total Crimson": a rule that took any label starting with
 * "total" for a totals row dropped those colours — or ended the table on them.
 */

/** Words that may follow "Total" in a totals label: "Total Qty", "Total pcs", "Grand total order qty". */
const TOTAL_TAIL_WORDS = '(?:qty|qtys|quantity|quantities|pcs|pc|pieces|units?|cartons?|ctns?|amount|value|price|cost|fob|usd|order|ordered|po|kgs?|gw|nw|weight)';
/** A figure written into the label's own cell: "Total: 1,200 pcs". */
const TOTAL_FIGURE = '(?:[\\d.,]+\\s*(?:pcs|pieces|units?|ctns?|cartons?|kgs?)?\\.?\\s*)*';

const LEADING_TOTAL = new RegExp(
  `^(?:grand\\s*|sub\\s*-?\\s*)?(?:totals?|ttl|sum)(?:[\\s./]+${TOTAL_TAIL_WORDS}\\.?)*\\s*[:：]?\\s*${TOTAL_FIGURE}$`,
  'i',
);
/** "Qty total", "Pieces total". */
const QTY_TOTAL = new RegExp(`^${TOTAL_TAIL_WORDS}\\s+totals?\\s*[:：]?\\s*${TOTAL_FIGURE}$`, 'i');
/** "Navy Total", "Style A Total": Excel's Data→Subtotal row, the group restated. */
const TRAILING_TOTAL = /\btotals?\s*[:：]?$/i;

/**
 * A totals label standing alone: "Total", "TOTAL:", "Totals", "Grand Total",
 * "Subtotal", "Sum", "Total Qty", "Total: 1,200 pcs", "Qty total" — and, unless
 * `trailing` is false, "<group> Total". "Total Orange" is not: a word after
 * "Total" that is not a unit makes it a name.
 */
export function isTotalsLabel(value: unknown, opts: { trailing?: boolean } = {}): boolean {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (LEADING_TOTAL.test(text) || QTY_TOTAL.test(text)) return true;
  return opts.trailing !== false && TRAILING_TOTAL.test(text);
}

/** Starts with the word "total" (or "grand total"/"subtotal"), whatever follows — a label to check by its numbers. */
export function startsWithTotalWord(value: unknown): boolean {
  return /^(?:grand\s*|sub\s*-?\s*)?totals?\b/i.test(String(value ?? '').trim());
}

/**
 * A line of a size grid that is not a colour: the pack ratio printed under
 * the sizes, the prepack, the price row, the carton count. Imported, "Ratio
 * 1 2 2 1" became a colour of six pieces.
 */
const NON_COLOUR_LABEL = /^(?:(?:pack|size|prepack|assortment|carton)\s*ratios?|ratios?|pre-?\s*packs?|assortments?|(?:unit\s*)?prices?|fob(?:\s*price)?|rate|cartons?|ctns?|no\.?\s*of\s*(?:cartons?|ctns?)|pcs\s*\/\s*(?:carton|ctn))$/i;
export function isNonColourLabel(value: unknown): boolean {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().replace(/[\s:：.]+$/, '');
  return text !== '' && NON_COLOUR_LABEL.test(text);
}
