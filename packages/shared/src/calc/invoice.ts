/**
 * The arithmetic of an invoice, as pure functions.
 *
 * Shared by the API (which stores lines and answers with totals) and the web
 * client (which recomputes while a draft is being edited), so the figure on the
 * screen and the figure on the issued document are the same arithmetic. A
 * total is never stored: it is the sum of the lines, every time it is asked for.
 *
 * Rounding: an amount is rounded to the cent once it is computed, and the
 * totals are sums of rounded cents, which is how the customer will check it —
 * line by line, on a calculator.
 */

import { InvoiceKind, InvoiceLineKind } from '../enums.js';

export interface InvoiceLineInput {
  kind: InvoiceLineKind;
  description: string;
  size?: string | null;
  /** Goods only. */
  quantity: number | null;
  /** Goods only. Dollars per unit. */
  unitPrice: number | null;
  /** Extras only. Dollars; negative for a discount. */
  amount: number | null;
}

export interface InvoiceLineTotal {
  /** Null when a goods line has no quantity or no price yet. */
  lineTotal: number | null;
}

export interface InvoiceTotals {
  /** Pieces over the goods lines. */
  totalQty: number;
  /** The goods lines, summed. */
  subtotal: number;
  /** The extras, summed (a discount pulls it down). */
  extras: number;
  total: number;
  /** True when a goods line still has no quantity or no price — the total is then a partial figure. */
  incomplete: boolean;
}

/** Cents, exactly: 5.95 × 122 is 725.9 and not 725.9000000000001. */
export const toCents = (v: number): number => Math.round(v * 100);
export const fromCents = (c: number): number => c / 100;

/**
 * quantity × unit price, to the cent, without floating-point residue and
 * without rounding the price first: a rate of 7.2535 on 122 pieces is 884.93,
 * not 884.50. Quantities carry up to four decimals and prices up to six (the
 * database columns), so both are scaled to integers and multiplied as BigInts.
 */
function goodsCents(quantity: number, unitPrice: number): number {
  const q = BigInt(Math.round(quantity * 1e4));
  const p = BigInt(Math.round(unitPrice * 1e6));
  const product = q * p; // dollars × 1e10
  const scale = 100_000_000n; // → cents
  const half = product < 0n ? -(scale / 2n) : scale / 2n;
  return Number((product + half) / scale);
}

export function lineTotal(line: InvoiceLineInput): number | null {
  if (line.kind === InvoiceLineKind.EXTRA) {
    return line.amount == null || !Number.isFinite(line.amount) ? null : fromCents(toCents(line.amount));
  }
  if (line.quantity == null || line.unitPrice == null) return null;
  if (!Number.isFinite(line.quantity) || !Number.isFinite(line.unitPrice)) return null;
  return fromCents(goodsCents(line.quantity, line.unitPrice));
}

export function computeInvoiceTotals(lines: readonly InvoiceLineInput[]): InvoiceTotals {
  let qty = 0;
  let subtotalCents = 0;
  let extrasCents = 0;
  let incomplete = false;
  for (const l of lines) {
    const t = lineTotal(l);
    if (l.kind === InvoiceLineKind.ITEM) {
      qty += l.quantity ?? 0;
      if (t == null) { incomplete = true; continue; }
      subtotalCents += toCents(t);
    } else if (t != null) {
      extrasCents += toCents(t);
    }
  }
  return {
    totalQty: qty,
    subtotal: fromCents(subtotalCents),
    extras: fromCents(extrasCents),
    total: fromCents(subtotalCents + extrasCents),
    incomplete,
  };
}

// ── Amount in words ──────────────────────────────────────────────────────────

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

function belowThousand(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h > 0) parts.push(`${ONES[h] ?? ''} Hundred`);
  if (rest > 0) {
    if (rest < 20) parts.push(ONES[rest] ?? '');
    else {
      const t = TENS[Math.floor(rest / 10)] ?? '';
      const o = rest % 10;
      parts.push(o > 0 ? `${t} ${ONES[o] ?? ''}` : t);
    }
  }
  return parts.join(' ');
}

/** 1,234 → "One Thousand Two Hundred Thirty Four". Zero is "Zero". */
export function integerInWords(n: number): string {
  const whole = Math.floor(Math.abs(n));
  if (whole === 0) return 'Zero';
  const groups: string[] = [];
  let rest = whole;
  let scale = 0;
  while (rest > 0 && scale < SCALES.length) {
    const g = rest % 1000;
    const scaleWord = SCALES[scale];
    if (g > 0) groups.unshift(`${belowThousand(g)}${scaleWord ? ` ${scaleWord}` : ''}`);
    rest = Math.floor(rest / 1000);
    scale += 1;
  }
  return groups.join(' ');
}

/**
 * The line under the totals: "United States Dollar Seven Hundred Thirty One
 * and Eighty Five Cents". Exactly what a bank or a customs officer expects to
 * read against the figure, including "Only" at the end when there are no cents.
 */
export function amountInWords(value: number, currencyName = 'United States Dollar'): string {
  const cents = toCents(Math.abs(value));
  const dollars = Math.floor(cents / 100);
  const c = cents % 100;
  const sign = value < 0 ? 'Minus ' : '';
  const head = `${sign}${currencyName} ${integerInWords(dollars)}`;
  if (c === 0) return `${head} Only`;
  return `${head} and ${integerInWords(c)} Cent${c === 1 ? '' : 's'}`;
}

// ── Numbering ────────────────────────────────────────────────────────────────

/** INV-2026-0379 — the prefix says which document, the year resets the count. */
export function formatInvoiceNumber(kind: InvoiceKind, year: number, sequence: number, prefix: Record<InvoiceKind, string>): string {
  return `${prefix[kind]}-${year}-${String(sequence).padStart(4, '0')}`;
}

// ── Shipped against ordered ──────────────────────────────────────────────────

export interface ReconciliationRow {
  label: string;
  ordered: number;
  shipped: number;
  /** ordered − shipped: positive is short, negative is over-shipped. */
  short: number;
}

export interface ReconciliationGroup {
  /** The colour, or the product the colour was sold as. */
  product: string;
  rows: ReconciliationRow[];
  ordered: number;
  shipped: number;
  short: number;
}

export interface ReconciliationResult {
  groups: ReconciliationGroup[];
  ordered: number;
  shipped: number;
  short: number;
}

/**
 * One row per (product, size), every size that was ordered or shipped, in the
 * order the sizes are sold. A size that shipped but was never ordered — a
 * sample, a spare — appears with nothing ordered, rather than vanishing.
 */
export function reconcileShippedAgainstOrdered(
  ordered: ReadonlyArray<{ product: string; label: string; qty: number }>,
  shipped: ReadonlyArray<{ product: string; label: string; qty: number }>,
  sizeOrder: readonly string[] = [],
): ReconciliationResult {
  const products: string[] = [];
  const byProduct = new Map<string, Map<string, ReconciliationRow>>();
  const bucket = (product: string, label: string) => {
    let rows = byProduct.get(product);
    if (!rows) { rows = new Map(); byProduct.set(product, rows); products.push(product); }
    let row = rows.get(label);
    if (!row) { row = { label, ordered: 0, shipped: 0, short: 0 }; rows.set(label, row); }
    return row;
  };
  for (const o of ordered) bucket(o.product, o.label).ordered += o.qty;
  for (const s of shipped) bucket(s.product, s.label).shipped += s.qty;

  const rank = (label: string) => {
    const i = sizeOrder.indexOf(label);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };

  const groups: ReconciliationGroup[] = products.map((product) => {
    const rows = [...byProduct.get(product)!.values()]
      .filter((r) => r.ordered !== 0 || r.shipped !== 0)
      .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label))
      .map((r) => ({ ...r, short: r.ordered - r.shipped }));
    const g = {
      product, rows,
      ordered: rows.reduce((a, r) => a + r.ordered, 0),
      shipped: rows.reduce((a, r) => a + r.shipped, 0),
      short: 0,
    };
    g.short = g.ordered - g.shipped;
    return g;
  }).filter((g) => g.rows.length > 0);

  const total = { ordered: 0, shipped: 0 };
  for (const g of groups) { total.ordered += g.ordered; total.shipped += g.shipped; }
  return { groups, ordered: total.ordered, shipped: total.shipped, short: total.ordered - total.shipped };
}

/**
 * The "Size" cell of a goods line: the sizes that shipped, compact. Up to four
 * are listed; a longer run is written as a range in the order the sizes are
 * sold, and nothing at all reads as "—" on the document.
 */
export function summariseSizes(labels: readonly string[], sizeOrder: readonly string[] = []): string | null {
  const unique = [...new Set(labels.filter((l) => l.trim().length > 0))];
  if (unique.length === 0) return null;
  const rank = (label: string) => sizeOrder.indexOf(label);
  // Sold sizes run as a range; anything else (a spare, a sample) is named after it.
  const sold = unique.filter((l) => rank(l) !== -1).sort((a, b) => rank(a) - rank(b));
  const other = unique.filter((l) => rank(l) === -1).sort((a, b) => a.localeCompare(b));
  const soldText = sold.length === 0 ? [] : sold.length <= 4 ? sold : [`${sold[0]} – ${sold[sold.length - 1]}`];
  return [...soldText, ...other].join(', ');
}

// ── Issuing ──────────────────────────────────────────────────────────────────

/**
 * What stops a draft being issued, in the words the screen shows. The API
 * applies the same list, so the button and the endpoint cannot disagree.
 */
export function issueBlockers(doc: {
  lines: ReadonlyArray<{ kind: InvoiceLineKind; quantity: number | null; unitPrice: number | null }>;
  billTo: string;
  stale: boolean;
}): string[] {
  const out: string[] = [];
  const goods = doc.lines.filter((l) => l.kind === InvoiceLineKind.ITEM);
  if (goods.length === 0) out.push('There are no goods lines. An invoice bills for something.');
  if (goods.some((l) => l.quantity == null || l.quantity <= 0)) out.push('Every goods line needs a quantity above zero.');
  if (goods.some((l) => l.unitPrice == null)) out.push('Every goods line needs a rate. Set the price on the order, or type one on the line.');
  if (!doc.billTo.trim()) out.push('The bill-to name is blank.');
  if (doc.stale) out.push('The cartons changed after this draft was built. Rebuild it so the document matches the packing list.');
  return out;
}

/**
 * How a document lists its goods: every colour and size as built
 * (`DETAILED`), or one line per style (per order when it is a single style)
 * with only its total pieces, rate and amount (`SUMMARY`). Only the listing changes — the stored lines, the totals
 * and the amount in words are the same either way.
 */
export const INVOICE_LINE_LAYOUTS = ['DETAILED', 'SUMMARY'] as const;
export type InvoiceLineLayout = (typeof INVOICE_LINE_LAYOUTS)[number];

export interface SummaryLine {
  description: string;
  quantity: number | null;
  /** The rate when every line of the order has the same one; otherwise the average. */
  unitPrice: number | null;
  /** True when the order's lines carry different rates, so the rate shown is an average. */
  mixedRates: boolean;
  lineTotal: number | null;
}

/**
 * The style each goods line belongs to, or null when its name shows none.
 * A buy sheet names the style inside the colour: "TRANMERE SHIRT — HUNTER/WHT"
 * (style before the dash) or "LEEDS JERSEY UNISEX BLACK" (the words it shares
 * with the line beside it, at least two of them, leaving a colour of one or
 * two words). Lines arrive in the order's colour order, so a style's colours
 * sit together.
 */
function stylesOf(texts: readonly string[]): Array<string | null> {
  const words = texts.map((t) => (t.includes(' — ') ? null : t.split(/\s+/).filter(Boolean)));
  const shared = (a: string[], b: string[]): number => {
    let n = 0;
    while (n < a.length && n < b.length && a[n]!.toLowerCase() === b[n]!.toLowerCase()) n++;
    const restA = a.length - n, restB = b.length - n;
    // "ST. JAMES TRACK JKT NAVY" beside "ST. JAMES TRACK PANT BLACK" share
    // three words, but two two-word remainders are two garments, not colours.
    return n >= 2 && restA >= 1 && restB >= 1 && restA <= 2 && restB <= 2 && !(restA === 2 && restB === 2) ? n : 0;
  };
  return texts.map((t, i) => {
    if (t.includes(' — ')) return t.slice(0, t.lastIndexOf(' — ')).trim() || null;
    const w = words[i]!;
    const n = Math.max(...[words[i - 1], words[i + 1]].map((o) => (o ? shared(w, o) : 0)));
    return n > 0 ? w.slice(0, n).join(' ') : null;
  });
}

/**
 * The goods lines reduced for a summary document: one line per style, or one
 * per order when the order is a single style. A line belongs to the order
 * whose "(PO x)" it ends with; on a one-order document, or for a line typed
 * without a PO, it belongs to the first order. A row with any line not yet
 * priced keeps its quantity and leaves rate and amount blank, as a detailed
 * line would.
 */
export function summariseGoods(
  lines: ReadonlyArray<InvoiceLineInput & { lineTotal?: number | null }>,
  orders: ReadonlyArray<{ poNumber: string; orderName: string; styleNumber?: string | null }>,
): SummaryLine[] {
  const goods = lines.filter((l) => l.kind === InvoiceLineKind.ITEM);
  if (orders.length === 0) return [];
  const groups = orders.map(() => [] as typeof goods);
  for (const l of goods) {
    const i = orders.length === 1 ? 0 : orders.findIndex((o) => l.description.trim().endsWith(`(PO ${o.poNumber})`));
    groups[i < 0 ? 0 : i]!.push(l);
  }
  const row = (description: string, g: typeof goods): SummaryLine => {
    const qty = g.reduce((a, l) => a + (l.quantity ?? 0), 0);
    // Each line's own total, the same exact cents the subtotal adds up, so the
    // summary row can never be a cent off the total printed under it.
    const totals = g.map((l) => lineTotal(l));
    const allPriced = totals.every((t) => t != null);
    const cents = allPriced ? totals.reduce((a, t) => a + toCents(t!), 0) : 0;
    const rates = new Set(g.map((l) => l.unitPrice));
    return {
      description,
      quantity: qty,
      // Until every line has a rate, rate and amount stay blank: a partial
      // figure next to the full quantity would not multiply out.
      unitPrice: !allPriced ? null : rates.size === 1 ? [...rates][0]! : qty > 0 ? fromCents(cents) / qty : null,
      mixedRates: allPriced && rates.size > 1,
      lineTotal: allPriced ? fromCents(cents) : null,
    };
  };
  return orders.flatMap((o, i) => {
    const g = groups[i]!;
    if (g.length === 0) return [];
    const po = orders.length > 1 ? `PO ${o.poNumber}` : null;
    // The description without its "(PO x)" and the order name a build puts in front.
    const texts = g.map((l) => {
      const t = l.description.trim().replace(/\s*\(PO [^()]*\)$/, '');
      const lead = `${o.orderName.trim()} — `;
      return t.toLowerCase().startsWith(lead.toLowerCase()) && t.length > lead.length ? t.slice(lead.length) : t;
    });
    const styles = stylesOf(texts);
    const byStyle = new Map<string, { name: string; lines: typeof goods }>();
    g.forEach((l, j) => {
      const name = styles[j] ?? texts[j]!;
      const entry = byStyle.get(name.toLowerCase()) ?? { name, lines: [] };
      entry.lines.push(l);
      byStyle.set(name.toLowerCase(), entry);
    });
    // A single style, or no style in the names at all (plain colours): the order is one line.
    if (byStyle.size <= 1 || styles.every((s) => s == null)) {
      return [row([o.orderName, o.styleNumber ? `Style ${o.styleNumber}` : null, po].filter(Boolean).join(' · '), g)];
    }
    return [...byStyle.values()].map((s) => row([s.name, po].filter(Boolean).join(' · '), s.lines));
  });
}
