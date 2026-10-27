/**
 * Reading a purchase order's lines and header the way a person reads them.
 *
 * The table reader in `pdf-extractor.ts` expects one row per item under a row
 * of column headings it recognises. Plenty of real purchase orders are not
 * laid out like that — ERP printouts above all (JD Edwards, SAP, Oracle) set
 * each item as a block of two or three printed lines: the description with its
 * quantity and prices, then the supplier's item code, then the colour and size.
 * Headings are split over two lines ("Description / Supplier Item"), the page
 * header repeats on every page, and labels carry no colons ("Order Number
 * 73287"). Kittrich PO 73287 is exactly that, and the table reader returned a
 * colour line as the PO number and none of the 23 items.
 *
 * This module does not depend on the layout. It finds the item lines by their
 * arithmetic — a line where one number times another equals a third *is* a
 * priced line, wherever its columns sit — and attaches the short lines beneath
 * it as that item's code, colour and size. Header details are read as
 * label-and-value with the value checked for the right kind (a date after a
 * date label, a number-bearing code after a PO-number label), so a stray word
 * cannot be taken for a field. The document's own printed total is the check
 * on the whole read.
 *
 * Pure functions over text lines: nothing here reads a PDF, so every rule is
 * testable by value.
 */

import { parseSpreadsheetDate } from '@opsflow/shared';
import { parseAmount } from './size-grid.js';

/** One printed line, as cells with the x position each started at. */
export interface PoCell { text: string; x: number; end?: number }
export type PoTextLine = PoCell[];

export interface PoLine {
  lineNumber: string | null;
  description: string;
  itemCode: string | null;
  colour: string | null;
  size: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  extended: number;
  requestDate: string | null;
}

export interface PoHeader {
  poNumber: string | null;
  orderDate: Date | null;
  deliveryDate: Date | null;
  client: string | null;
  shipTo: string | null;
  currency: string | null;
  terms: string | null;
  shippingMethod: 'Sea' | 'Air' | null;
  printedTotal: number | null;
}

// ── Numbers and dates ───────────────────────────────────────────────────────

const DATE_RE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
/** A printed number in either decimal convention ("1,234.56", "14,00"). */
function num(token: string): number | null {
  return parseAmount(token);
}

/**
 * Whether this document writes day or month first, from its own dates.
 *
 * A date whose first part is over 12 can only be day-first; one whose second
 * part is over 12 can only be month-first. A US purchase order dated 4/28/2022
 * settles it for every other date on the page, including the ambiguous ones.
 * With no deciding date, day-first, the house convention elsewhere.
 */
export function detectDayFirst(dates: readonly string[]): boolean {
  for (const d of dates) {
    const [a, b] = d.split(/[/.-]/).map(Number);
    if (a! > 12 && b! <= 12) return true;
    if (b! > 12 && a! <= 12) return false;
  }
  return true;
}

function parseDate(text: string, dayFirst: boolean): Date | null {
  return DATE_RE.test(text.trim()) ? parseSpreadsheetDate(text.trim(), dayFirst).value : null;
}

// ── Sizes and colours ───────────────────────────────────────────────────────

/** Who a size is for. Kept in the size label: "Youth Small" is not "Adult Small". */
const SIZE_GROUPS: Record<string, string> = {
  YOUTH: 'Youth', YTH: 'Youth', KIDS: 'Kids', KID: 'Kids', CHILD: 'Kids', CHILDREN: 'Kids', JUNIOR: 'Junior', JR: 'Junior',
  ADULT: 'Adult', ADT: 'Adult', MEN: 'Men', MENS: 'Men', WOMEN: 'Women', WOMENS: 'Women', LADIES: 'Women',
  BOYS: 'Boys', GIRLS: 'Girls', INFANT: 'Infant', TODDLER: 'Toddler',
};

/** Size words, with the order they sort in. */
const SIZE_WORDS: Record<string, { label: string; rank: number }> = {
  XXXS: { label: 'XXXS', rank: 1 }, XXS: { label: 'XXS', rank: 2 }, '2XS': { label: 'XXS', rank: 2 },
  XS: { label: 'XS', rank: 3 }, 'X-SMALL': { label: 'XS', rank: 3 }, XSMALL: { label: 'XS', rank: 3 },
  S: { label: 'Small', rank: 4 }, SM: { label: 'Small', rank: 4 }, SMALL: { label: 'Small', rank: 4 },
  M: { label: 'Medium', rank: 5 }, MD: { label: 'Medium', rank: 5 }, MED: { label: 'Medium', rank: 5 }, MEDIUM: { label: 'Medium', rank: 5 },
  L: { label: 'Large', rank: 6 }, LG: { label: 'Large', rank: 6 }, LARGE: { label: 'Large', rank: 6 },
  XL: { label: 'XL', rank: 7 }, 'X-LARGE': { label: 'XL', rank: 7 }, XLARGE: { label: 'XL', rank: 7 },
  XXL: { label: 'XXL', rank: 8 }, '2XL': { label: 'XXL', rank: 8 }, 'XX-LARGE': { label: 'XXL', rank: 8 }, XXLARGE: { label: 'XXL', rank: 8 },
  XXXL: { label: '3XL', rank: 9 }, '3XL': { label: '3XL', rank: 9 }, '4XL': { label: '4XL', rank: 10 }, '5XL': { label: '5XL', rank: 11 },
  OS: { label: 'One Size', rank: 0 }, OSFA: { label: 'One Size', rank: 0 },
};

const GROUP_RANK: Record<string, number> = { Infant: 0, Toddler: 1, Kids: 2, Boys: 2, Girls: 2, Junior: 3, Youth: 3, Adult: 5, Men: 5, Women: 5 };

/** Sort key for a size label, so a grid reads Youth Small … Adult Large. */
export function sizeSortKey(label: string): number {
  const parts = label.split(' ');
  // A bare group ("Adult", "Youth") is a size of its own, ahead of that group's sized garments.
  if (parts.length === 1 && GROUP_RANK[parts[0]!] != null) return GROUP_RANK[parts[0]!]! * 100;
  const group = parts.length > 1 ? GROUP_RANK[parts[0]!] ?? 4 : 4;
  const word = parts[parts.length - 1]!;
  const rank = Object.values(SIZE_WORDS).find((w) => w.label === word)?.rank
    ?? (/^\d+$/.test(word) ? 20 + Number(word) / 1000 : 50);
  return group * 100 + rank;
}

/**
 * Sizes in wearing order — Youth Small before Adult Large — when every one of
 * them is a size the key knows. A grid read in document order can come out
 * "XL L M" because that is the order the lines were printed in; a label the
 * key cannot place (a customer's own "2X-SMALL") keeps the document's order
 * for the whole grid, since a half-sorted grid is worse than an unsorted one.
 */
export function orderSizes(sizes: readonly string[]): string[] {
  const keys = sizes.map(sizeRank);
  if (keys.some((k) => k == null)) return [...sizes];
  return sizes.map((s, i) => ({ s, k: keys[i]! })).sort((a, b) => a.k - b.k).map((x) => x.s);
}

/**
 * Where a size is worn, smallest first, or null for a label nobody can rank
 * (a customer's own "2X-SMALL"). Raw labels — "L", "Youth LG", "28" — rather
 * than the canonical ones, so each is looked up by its word and group directly.
 */
export function sizeRank(label: string): number | null {
  // One-size goods (a bag, a bib) sit after every sized garment.
  if (/^(one size|os|osfa|free size|free)$/i.test(label.trim())) return 999;
  // A combined size ("S/M", "L/XL") sits between its two halves.
  if (label.includes('/')) {
    const halves = label.split('/').map((h) => sizeRank(h.trim()));
    return halves.every((h): h is number => h != null) ? halves.reduce((a, h) => a + h, 0) / halves.length : null;
  }
  // The factory's compact youth codes: YS, YM, YL, YXS, 2YXS — youth, then
  // the size, with a leading count of X's ("2YXS" is youth 2XS).
  const youth = /^(\d)?Y(X*[SML]|X+L)$/i.exec(label.trim());
  if (youth) {
    const adult = sizeRank(`${youth[1] ?? ''}${youth[2]}`);
    if (adult != null) return 300 + (adult % 100);
  }
  const parts = label.trim().toUpperCase().split(/\s+/);
  if (parts.length === 1 && SIZE_GROUPS[parts[0]!]) return (GROUP_RANK[SIZE_GROUPS[parts[0]!]!] ?? 4) * 100;
  const word = parts[parts.length - 1]!;
  const group = parts.length > 1 ? GROUP_RANK[SIZE_GROUPS[parts[0]!] ?? ''] ?? 4 : 4;
  const rank = SIZE_WORDS[word]?.rank ?? (/^\d+$/.test(word) ? 20 + Number(word) / 1000 : null);
  return rank == null ? null : group * 100 + rank;
}

/**
 * An order's size columns as they are shown: smallest on the left. Sizes that
 * can be ranked are put in wearing order among the places they occupy; a
 * label nobody can rank keeps its own place. Positions are renumbered to
 * match, so every screen that sorts by position shows the same order —
 * whatever order the sizes were saved in, by an import or by hand.
 */
export function inWearingOrder<T extends { name: string; position: number }>(sizes: readonly T[]): T[] {
  const saved = [...sizes].sort((a, b) => a.position - b.position);
  const ranked = saved
    .map((s) => ({ s, k: sizeRank(s.name) }))
    .filter((x): x is { s: T; k: number } => x.k != null)
    .sort((a, b) => a.k - b.k || a.s.position - b.s.position)
    .map((x) => x.s);
  let next = 0;
  return saved
    .map((s) => (sizeRank(s.name) == null ? s : ranked[next++]!))
    .map((s, position) => ({ ...s, position }));
}

/**
 * Split "ROY/WHT YOUTH SMALL" into colour "ROY/WHT" and size "Youth Small".
 *
 * The size is read from the end of the text: an optional group (Youth, Adult,
 * Women…) and a size word or a number. Whatever precedes it is the colour.
 * Text with no size at its end is all colour; a line that is only a size has
 * no colour.
 */
export function splitColourSize(text: string): { colour: string | null; size: string | null } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { colour: null, size: null };
  const last = tokens[tokens.length - 1]!.toUpperCase();
  // "ONE SIZE" and "FREE SIZE" are two words for one size — a bag, a bib, a
  // ball — and read one word at a time "SIZE" was no size and 1,000 bags
  // vanished from the order.
  if (tokens.length >= 2 && last === 'SIZE' && /^(ONE|FREE)$/.test(tokens[tokens.length - 2]!.toUpperCase())) {
    const colour = tokens.slice(0, tokens.length - 2).join(' ') || null;
    return { colour, size: 'One Size' };
  }
  let sizeWord = SIZE_WORDS[last]?.label ?? null;
  // Numeric sizes ("128", "10", "2-3Y") only count after a group word or alone,
  // so a colour code such as "Pantone 186" is not read as size 186.
  const numeric = /^\d{1,3}(-\d{1,3})?Y?$/.test(last) ? last : null;
  let consumed = 1;
  const before = tokens.length >= 2 ? tokens[tokens.length - 2]!.toUpperCase() : null;
  const group = before ? SIZE_GROUPS[before] ?? null : null;
  if (!sizeWord && numeric && (group || tokens.length === 1)) sizeWord = numeric;
  // A group word on its own is a size: a training bib comes in "ADULT" and
  // "YOUTH", nothing finer, and "SKY ADULT" is a sky-blue adult bib.
  if (!sizeWord && SIZE_GROUPS[last] && tokens.length >= 2) {
    return { colour: tokens.slice(0, -1).join(' ') || null, size: SIZE_GROUPS[last]! };
  }
  if (!sizeWord) return { colour: tokens.join(' '), size: null };
  // "EXTRA LARGE" and "EXTRA SMALL" are two words for one size.
  if (sizeWord === 'Large' && before === 'EXTRA') { sizeWord = 'XL'; consumed = 2; }
  if (sizeWord === 'Small' && before === 'EXTRA') { sizeWord = 'XS'; consumed = 2; }
  const groupLabel = tokens.length > consumed ? SIZE_GROUPS[tokens[tokens.length - consumed - 1]!.toUpperCase()] ?? null : null;
  if (groupLabel) consumed += 1;
  const size = groupLabel ? `${groupLabel} ${sizeWord}` : sizeWord;
  const colour = tokens.slice(0, tokens.length - consumed).join(' ') || null;
  return { colour, size };
}

// ── Item lines ──────────────────────────────────────────────────────────────

const UNIT_WORDS = new Set(['EA', 'EACH', 'PC', 'PCS', 'PIECE', 'PIECES', 'UNIT', 'UNITS', 'SET', 'SETS', 'DZ', 'DOZ', 'PR', 'PAIR', 'PAIRS', 'PK', 'PACK']);

/** A supplier or buyer item code: letters and digits joined by hyphens, with a digit in it. */
const ITEM_CODE = /^[A-Z0-9]{2,}(?:[-_./][A-Z0-9]+){1,6}$/i;

/** A totals line restates the order rather than adding to it. */
const TOTAL_LINE = /^(total|sub\s*total|grand\s*total|order\s*total|total\s*order|amount\s*due)\b/i;

interface Priced { qtyIdx: number; priceIdx: number; extIdx: number; qty: number; price: number; ext: number }

/**
 * The quantity, unit price and extended price on a line, found by arithmetic.
 *
 * Three numbers in reading order where the first times the second is the
 * third, to the cent. Where several triples fit — a line number of 1 times a
 * total equals the total — the one nearest the end of the line wins, because
 * that is where every purchase order puts its money.
 */
export function findPricedNumbers(tokens: readonly string[]): Priced | null {
  const nums: Array<{ i: number; v: number }> = [];
  tokens.forEach((t, i) => { if (!DATE_RE.test(t)) { const v = num(t); if (v != null) nums.push({ i, v }); } });
  let best: Priced | null = null;
  for (let e = nums.length - 1; e >= 2; e--) {
    const ext = nums[e]!;
    if (ext.v <= 0) continue;
    for (let p = e - 1; p >= 1; p--) {
      for (let q = p - 1; q >= 0; q--) {
        const qty = nums[q]!.v, price = nums[p]!.v;
        if (qty <= 0 || price <= 0) continue;
        if (Math.abs(qty * price - ext.v) <= Math.max(0.011, ext.v * 0.0005)) {
          const cand = { qtyIdx: nums[q]!.i, priceIdx: nums[p]!.i, extIdx: ext.i, qty, price, ext: ext.v };
          if (!best || cand.extIdx > best.extIdx || (cand.extIdx === best.extIdx && cand.qtyIdx > best.qtyIdx)) best = cand;
        }
      }
    }
    if (best) return best;
  }
  return best;
}

/**
 * A line's text with its numbers blanked, for recognising a page header that
 * repeats with a different page number ("Page - 1", "Page - 2").
 */
export function boilerplateKey(text: string): string {
  return text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * The lines that are page furniture: the same text, numbers aside, on every
 * page and at the same height on each. Height is what separates a running
 * header from an item line that happens to recur — "BLACK/WH ADULT MEDIUM" can
 * appear on two pages, but not in the same place on every one.
 */
export function findBoilerplate(pages: ReadonlyArray<ReadonlyArray<{ text: string; y: number }>>): Set<string> {
  const out = new Set<string>();
  if (pages.length < 2) return out;
  const [first, ...rest] = pages;
  for (const line of first!) {
    const key = boilerplateKey(line.text);
    if (!key) continue;
    if (rest.every((p) => p.some((l) => boilerplateKey(l.text) === key && Math.abs(l.y - line.y) <= 4))) out.add(key);
  }
  return out;
}

/** A line's text split into words, keeping cells' words in order. */
function tokensOf(line: PoTextLine): string[] {
  return line.flatMap((c) => c.text.split(/\s+/)).filter(Boolean);
}

/**
 * Every priced item line, with the short lines beneath it read as its code,
 * colour and size.
 *
 * @param boilerplate Line texts that repeat on every page (the page header and
 *   the column headings). They are skipped, so an item that starts at the foot
 *   of one page keeps its colour and size from the top of the next.
 */
export function readPoLines(lines: readonly PoTextLine[], boilerplate: ReadonlySet<string>, dayFirst: boolean): PoLine[] {
  const out: PoLine[] = [];
  let current: PoLine | null = null;
  let followers = 0;

  for (const line of lines) {
    const text = line.map((c) => c.text).join(' ').trim();
    if (!text || boilerplate.has(boilerplateKey(text))) continue;
    if (TOTAL_LINE.test(text)) { current = null; continue; }
    const tokens = tokensOf(line);
    const priced = findPricedNumbers(tokens);

    if (priced) {
      // Words that are not numbers, dates or units, in order: the description.
      const unitTok = tokens.find((t, i) => i > priced.qtyIdx && i < priced.extIdx && UNIT_WORDS.has(t.toUpperCase()));
      const lead = tokens.slice(0, priced.qtyIdx);
      const lineNumber = lead.length > 0 && num(lead[0]!) != null ? lead[0]! : null;
      const description = lead
        .filter((t, i) => !(i <= 1 && num(t) != null))   // line number and revision
        .join(' ').trim();
      const dateTok = tokens.slice(priced.extIdx + 1).find((t) => DATE_RE.test(t));
      const date = dateTok ? parseDate(dateTok, dayFirst) : null;
      current = {
        lineNumber,
        description: description || 'Item',
        itemCode: null, colour: null, size: null,
        quantity: priced.qty, unit: unitTok ? normaliseUnit(unitTok) : 'PCS',
        unitPrice: priced.price, extended: priced.ext,
        requestDate: date ? date.toISOString().slice(0, 10) : null,
      };
      // A description cell that already ends in a size ("Polo Navy XL") carries it.
      const own = splitColourSize(description);
      if (own.size) { current.size = own.size; }
      out.push(current);
      followers = 0;
      continue;
    }

    // A short line under an item is part of it: its code, then its colour and size.
    if (current && followers < 4 && tokens.length <= 8 && !tokens.some((t) => num(t) != null && !ITEM_CODE.test(t) && Number(t.replace(/,/g, '')) > 999)) {
      followers += 1;
      if (tokens.length === 1 && ITEM_CODE.test(tokens[0]!) && /\d/.test(tokens[0]!) && !current.itemCode) {
        current.itemCode = tokens[0]!;
        continue;
      }
      const { colour, size } = splitColourSize(text);
      if (size && !current.size) current.size = size;
      if (colour && !current.colour) current.colour = colour;
      continue;
    }
    current = null;
  }
  return out;
}

function normaliseUnit(u: string): string {
  const t = u.toUpperCase();
  if (['EA', 'EACH', 'PC', 'PCS', 'PIECE', 'PIECES', 'UNIT', 'UNITS'].includes(t)) return 'PCS';
  if (['PR', 'PAIR', 'PAIRS'].includes(t)) return 'PAIRS';
  if (['SET', 'SETS'].includes(t)) return 'SETS';
  if (['DZ', 'DOZ'].includes(t)) return 'DOZEN';
  return t;
}

// ── Header ──────────────────────────────────────────────────────────────────

const PO_LABELS = ['order number', 'po number', 'po no', 'po no.', 'po #', 'po', 'purchase order', 'purchase order number', 'order no', 'order no.', 'order #', 'p.o. number', 'p.o. no', 'p.o. no.', 'p.o.', 'p.o. #', 'p.o number', 'p.o no'];
const ORDER_DATE_LABELS = ['ordered', 'order date', 'po date', 'date ordered', 'issue date', 'date of order'];
const DELIVERY_LABELS = ['requested', 'request date', 'requested delivery', 'delivery date', 'required date', 'due date', 'need by', 'deliver by', 'ship by', 'ex factory', 'ex-factory'];
const SHIP_TO_LABELS = ['ship to', 'deliver to', 'delivery address', 'consignee', 'ship-to'];
const SELF = /soccertex|al\s*shimaa|\bAGE\b/i;
const COMPANY = /\b(corporation|corp\.?|company|incorporated|inc\.?|ltd\.?|limited|llc|l\.l\.c\.|gmbh|b\.?v\.?|s\.?l\.?|s\.?a\.?|plc|a\/s|co\.)\s*$/i;

const CURRENCY_LABELS = ['currency code', 'currency'];
const TERMS_LABELS = ['term', 'terms', 'payment terms'];
const FREIGHT_LABELS = ['freight', 'ship via', 'shipping method', 'mode', 'shipment mode', 'transport'];
const TOTAL_LABELS = ['total order', 'order total', 'grand total', 'total amount', 'goods total', 'total value', 'total'];
const ALL_LABELS = [...new Set([...PO_LABELS, ...ORDER_DATE_LABELS, ...DELIVERY_LABELS, ...SHIP_TO_LABELS,
  ...CURRENCY_LABELS, ...TERMS_LABELS, ...FREIGHT_LABELS, ...TOTAL_LABELS])]
  .map((l) => l.split(' '))
  .sort((a, b) => b.length - a.length);

const lc = (s: string) => s.toLowerCase().replace(/[:#]\s*$/, (m) => (m.includes('#') ? ' #' : '')).replace(/\s+/g, ' ').trim();

/**
 * Split cells where a known label starts inside them.
 *
 * A PDF sets a label and its value close together, and the cell reader joins
 * anything closer than a column gap: "Ship To Kittrich Pomona", "Requested
 * 5/30/2022 Order Taken By", "4/28/2022 Freight OCC Ocean Collect". Each label
 * becomes a cell of its own, followed by what came after it, and the x of each
 * piece is placed in proportion to where its text sat in the cell.
 */
export function splitAtLabels(line: PoTextLine): PoTextLine {
  const out: PoCell[] = [];
  for (const cell of line) {
    const words = cell.text.trim().split(/\s+/);
    const width = cell.end != null && cell.end > cell.x ? cell.end - cell.x : cell.text.length * 4.5;
    const xAt = (wordIndex: number) => {
      const chars = words.slice(0, wordIndex).join(' ').length + (wordIndex > 0 ? 1 : 0);
      return cell.x + (width * chars) / Math.max(1, cell.text.trim().length);
    };
    let start = 0;
    const push = (from: number, to: number) => {
      if (to > from) out.push({ text: words.slice(from, to).join(' '), x: xAt(from) });
    };
    for (let i = 0; i < words.length; i++) {
      const match = ALL_LABELS.find((l) => l.every((w, k) => words[i + k] != null && lc(words[i + k]!) === w));
      if (!match) continue;
      push(start, i);
      push(i, i + match.length);
      start = i + match.length;
      i = start - 1;
    }
    push(start, words.length);
  }
  return out;
}

/**
 * The header of a purchase order: number, dates, buyer, ship-to, terms.
 *
 * A label is believed only when the value beside it is the right kind — a date
 * after a date label, a code with a digit after a PO-number label — so two
 * unrelated words that share a line cannot become a field.
 */
export function readPoHeader(lines: readonly PoTextLine[], dayFirst: boolean): PoHeader {
  const h: PoHeader = {
    poNumber: null, orderDate: null, deliveryDate: null, client: null, shipTo: null,
    currency: null, terms: null, shippingMethod: null, printedTotal: null,
  };

  let namedTotal = false;
  const split = lines.map(splitAtLabels);
  for (const [li, line] of split.entries()) {
    for (let i = 0; i < line.length; i++) {
      const label = lc(line[i]!.text);
      const next = line[i + 1]?.text.trim() ?? '';

      if (!h.poNumber && PO_LABELS.includes(label) && next) {
        // "73287 000 OI": the order number, then an ERP's company and type codes.
        const first = next.split(/\s+/)[0]!;
        if (/\d/.test(first) && first.length >= 3 && first.length <= 30) h.poNumber = first;
      }
      const firstWord = next.split(/\s+/)[0] ?? '';
      if (!h.orderDate && ORDER_DATE_LABELS.includes(label)) h.orderDate = parseDate(firstWord, dayFirst) ?? h.orderDate;
      if (!h.deliveryDate && DELIVERY_LABELS.includes(label)) h.deliveryDate = parseDate(firstWord, dayFirst) ?? h.deliveryDate;
      if (!h.currency && CURRENCY_LABELS.includes(label) && /^[A-Z]{3}$/.test(firstWord)) h.currency = firstWord;
      if (!h.terms && TERMS_LABELS.includes(label) && next) h.terms = next;
      if (!h.shippingMethod && FREIGHT_LABELS.includes(label)) {
        const rest = line.slice(i + 1, i + 3).map((c) => c.text).join(' ');
        h.shippingMethod = /\b(ocean|sea|vessel)\b/i.test(rest) ? 'Sea' : /\b(air|airfreight)\b/i.test(rest) ? 'Air' : null;
      }
      // The money total. A named one ("Goods total", "Order total") is taken
      // at once. A bare "Total" also heads the check line under a size grid
      // ("Total 3 5 5 13"), so it counts only when it carries a single number,
      // and the last such line in the document is the one kept.
      if (TOTAL_LABELS.includes(label)) {
        const after = line.slice(i + 1).flatMap((c) => c.text.trim().split(/\s+/)).filter((t) => !/^[A-Z]{3}$/.test(t));
        const values = after.map((t) => num(t)).filter((v): v is number => v != null);
        const v = values[0];
        if (v != null && v > 0) {
          if (label !== 'total') { if (!namedTotal) { h.printedTotal = v; namedTotal = true; } }
          else if (!namedTotal && values.length === 1 && after.length === 1) h.printedTotal = v;
        }
      }

      // The ship-to block: the value beside the label and the lines beneath it
      // that start in the same place. A value far across the page
      // belongs to something else (another company's letterhead), so then
      // the block is read from beneath the label instead.
      if (!h.shipTo && SHIP_TO_LABELS.includes(label)) {
        const labelCell = line[i]!;
        const beside = line[i + 1] && line[i + 1]!.x - labelCell.x <= labelCell.text.length * 7 + 60 ? line[i + 1]! : null;
        const x = beside ? beside.x : labelCell.x;
        const parts = beside ? [beside.text.trim()] : [];
        for (let k = li + 1; k < Math.min(split.length, li + 6); k++) {
          const cell = split[k]!.find((c) => Math.abs(c.x - x) <= 10);
          if (!cell) break;
          parts.push(cell.text.trim());
        }
        if (parts.length > 0 && !SELF.test(parts.join(' '))) h.shipTo = parts.join(', ');
      }
    }
  }

  // The buyer: a company name standing alone near the top that is not us —
  // the letterhead every purchase order carries. Read from the first lines only.
  for (const line of lines.slice(0, 12)) {
    for (const c of line) {
      const t = c.text.trim();
      if (COMPANY.test(t) && !SELF.test(t) && t.length < 70 && t.split(/\s+/).length <= 6) { h.client = t; break; }
    }
    if (h.client) break;
  }
  return h;
}

// ── Lines into an order ─────────────────────────────────────────────────────

export interface PoOrder {
  /** Colour rows × size columns, for the order's quantity matrix. */
  matrix: { sizes: string[]; rows: Array<{ color: string; cells: Record<string, number>; total: number }> } | null;
  orderName: string | null;
  styleNumber: string | null;
  /** The single price per piece, or the revenue-weighted average when prices differ. */
  pricePerPiece: number | null;
  pricesVary: boolean;
  totalQty: number;
  totalValue: number;
  styles: string[];
}

/**
 * Turn PO lines into the shape an order holds.
 *
 * An order has one quantity grid of colours by sizes. A PO that covers several
 * styles still fits: each style's colour becomes a row of its own ("Harrogate
 * Shirt — ROY/WHT"), so no line is merged into another and every quantity is
 * where the document put it.
 */
export function poLinesToOrder(lines: readonly PoLine[]): PoOrder {
  const styles = [...new Set(lines.map((l) => l.description))];
  const multi = styles.length > 1;
  const byRow = new Map<string, Record<string, number>>();
  const sizes = new Set<string>();
  for (const l of lines) {
    const colour = l.colour ?? 'As ordered';
    const row = multi ? `${titleCase(l.description)} — ${colour}` : colour;
    const size = l.size ?? 'One Size';
    sizes.add(size);
    const cells = byRow.get(row) ?? {};
    cells[size] = (cells[size] ?? 0) + l.quantity;
    byRow.set(row, cells);
  }
  const sortedSizes = [...sizes].sort((a, b) => sizeSortKey(a) - sizeSortKey(b));
  const totalQty = lines.reduce((a, l) => a + l.quantity, 0);
  const totalValue = Math.round(lines.reduce((a, l) => a + l.extended, 0) * 100) / 100;
  const prices = new Set(lines.map((l) => l.unitPrice));
  const codes = [...new Set(lines.map((l) => l.itemCode?.split(/[-_./]/).slice(0, 2).join('-')).filter(Boolean))] as string[];
  return {
    matrix: lines.length === 0 ? null : {
      sizes: sortedSizes,
      rows: [...byRow].map(([color, cells]) => ({ color, cells, total: Object.values(cells).reduce((a, b) => a + b, 0) })),
    },
    orderName: styles.length === 1 ? titleCase(styles[0]!) : null,
    styleNumber: codes.length === 1 ? codes[0]! : null,
    pricePerPiece: prices.size === 1 ? lines[0]!.unitPrice
      : totalQty > 0 ? Math.round((totalValue / totalQty) * 10000) / 10000 : null,
    pricesVary: prices.size > 1,
    totalQty,
    totalValue,
    styles: styles.map(titleCase),
  };
}

/** "HARROGATE SHIRT" → "Harrogate Shirt"; a word with a digit in it ("SG1") is a code and keeps its case. */
function titleCase(s: string): string {
  return s.split(/\s+/).map((w) => (/\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
}
