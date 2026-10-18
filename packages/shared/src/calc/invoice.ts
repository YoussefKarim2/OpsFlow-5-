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

export function lineTotal(line: InvoiceLineInput): number | null {
  if (line.kind === InvoiceLineKind.EXTRA) {
    return line.amount == null || !Number.isFinite(line.amount) ? null : fromCents(toCents(line.amount));
  }
  if (line.quantity == null || line.unitPrice == null) return null;
  if (!Number.isFinite(line.quantity) || !Number.isFinite(line.unitPrice)) return null;
  return fromCents(Math.round(line.quantity * toCents(line.unitPrice)));
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
  const rank = (label: string) => {
    const i = sizeOrder.indexOf(label);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  unique.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  if (unique.length <= 4) return unique.join(', ');
  return `${unique[0]} – ${unique[unique.length - 1]}`;
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
