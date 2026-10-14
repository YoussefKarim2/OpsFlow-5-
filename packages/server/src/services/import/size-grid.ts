/**
 * Reading a purchase order's size grids: colours down, sizes across.
 *
 * Most garment purchase orders print, for each style, a row of size headings
 * ("XS S M L XL …", "116 128 140", "Youth S / Youth M") with one line per
 * colour beneath, the pieces under each size, then the colour's quantity,
 * price and amount. The generic table reader needs every value of a row on one
 * baseline, and real documents break that constantly:
 *
 *  - Meyba PO 311 prints each colour's size quantities four points above the
 *    colour name, and a line of EAN barcodes under them, so no single printed
 *    line holds a colour and its quantities;
 *  - several styles each carry their own size heading, separated by a style
 *    title and "Season / Tariff No." lines;
 *  - prices use a decimal comma ("14,00").
 *
 * This reader is built on geometry, not on lines. A size heading defines the
 * columns. Every number under a size column belongs to the colour whose label
 * is nearest it vertically. Barcodes (eight digits or more) are never pieces.
 * A "Total" line under the grid is the check on the grid, not a colour.
 *
 * Every row is verified where the document allows: the sizes must add up to
 * the row's own Quantity column, and quantity × price must equal its amount.
 * The caller verifies the whole order against the printed piece count.
 *
 * Pure functions over positioned lines: nothing here reads a PDF.
 */

/** One printed cell with its horizontal span. */
export interface GridCell { text: string; x: number; end: number }
/** One printed line: its cells and its baseline height (larger is higher up the page). */
export interface GridLine { cells: GridCell[]; y: number; page: number }

export interface GridRow {
  colour: string;
  cells: Record<string, number>;
  total: number;
  /** The row's own printed quantity, when the grid has that column. */
  printedQty: number | null;
  price: number | null;
  amount: number | null;
}

export interface GridBlock {
  style: string | null;
  styleCode: string | null;
  sizes: string[];
  rows: GridRow[];
  /** The grid's own printed total row, per size and overall, when there is one. */
  printedTotal: number | null;
  problems: string[];
}

// ── Numbers ─────────────────────────────────────────────────────────────────

/**
 * A number as printed, in either convention: "1,234.56", "1.234,56", "14,00",
 * "448,00 USD", "$ 12.50". A single comma followed by exactly two digits, or
 * by one, is a decimal comma; followed by three it is a thousands separator.
 */
export function parseAmount(raw: string): number | null {
  let t = raw.replace(/[$€£¥]|\b(USD|EUR|GBP|EGP)\b/gi, '').replace(/\s+/g, '');
  if (!t || !/^-?[\d.,]+$/.test(t) || !/\d/.test(t)) return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever comes last is the decimal mark.
    t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimals = t.length - lastComma - 1;
    const commas = (t.match(/,/g) ?? []).length;
    t = commas === 1 && decimals !== 3 ? t.replace(',', '.') : t.replace(/,/g, '');
  } else if ((t.match(/\./g) ?? []).length > 1) {
    t = t.replace(/\./g, ''); // "1.234.567"
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A barcode, EAN or article number: never a quantity. */
const BARCODE = /^\d{8,}$/;

/** A whole-number piece count as printed ("12", "1,200", "12.0000"). */
function pieces(text: string): number | null {
  const t = text.trim();
  if (BARCODE.test(t)) return null;
  const n = parseAmount(t);
  if (n == null || n < 0 || n > 1_000_000) return null;
  return Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : null;
}

// ── Size headings ───────────────────────────────────────────────────────────

const LETTER_SIZE = /^(\d?X{0,7}S|M|\d?X{0,7}L|\d{1,2}XL|\d{1,2}XS|XXS|XXXS|SM|MD|LG|S\/M|M\/L|L\/XL|XS\/S|XL\/XXL|OS|OSFA|ONE\s?SIZE|TU|FREE)$/i;
const WORD_SIZE = /^(X-?SMALL|SMALL|MEDIUM|LARGE|X-?LARGE|XX-?LARGE|EXTRA\s+LARGE)$/i;
// Longest words first, so "Youth S" is read as Youth + S, not Y + "outh S".
const GROUP = /^(YOUTH|YTH|KIDS|KID|JUNIOR|JR|SENIOR|SR|ADULT|WOMENS|WOMEN|LADIES|MENS|MEN|BOYS|GIRLS|INFANT|INF|TODDLER|CHILD|CH|Y|K|A|W|M)[-\s]?/i;
const AGE_SIZE = /^\d{1,2}\s?([-/]\s?\d{1,2})?\s?(Y|YR|YRS|YEARS?|M|MTHS?|MONTHS?)$/i;
const RANGE_SIZE = /^\d{1,2}[-/]\d{1,2}$/;
const NUMERIC_SIZE = /^\d{1,3}$/;

/** Whether a heading word is a size: letter, word, grouped ("Youth S", "YM"), age or number. */
export function isSizeLabel(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 16) return false;
  if (LETTER_SIZE.test(t) || WORD_SIZE.test(t) || AGE_SIZE.test(t) || RANGE_SIZE.test(t)) return true;
  const rest = t.replace(GROUP, '');
  if (rest !== t && rest && (LETTER_SIZE.test(rest) || WORD_SIZE.test(rest) || NUMERIC_SIZE.test(rest) || AGE_SIZE.test(rest))) return true;
  return NUMERIC_SIZE.test(t) && Number(t) > 0 && Number(t) <= 200;
}

const QTY_WORDS = /^(quantity|qty|pcs|pieces|units|total\s*qty|total\s*pcs|order\s*qty|ordered|amount\s*pcs)$/i;
const PRICE_WORDS = /^(price|unit\s*price|fob|fob\s*price|rate|unit\s*cost|cost|price\/pc)$/i;
const TOTAL_WORDS = /^(total|amount|value|line\s*total|total\s*amount|total\s*value|ext\.?\s*price|extended)$/i;
const ROW_TOTAL = /^(total|totals|sub\s*total|subtotal|sum|grand\s*total)\b/i;
/**
 * The document's own piece count, printed under the grid — "Pieces 105",
 * "Total pieces 620". It ends the grid like a Total line does; read as a colour
 * it doubled the order and the grid lost to a reading that had read less.
 */
const PIECES_LINE = /^(pieces|total\s*pieces|total\s*pcs|total\s*qty|total\s*quantity|total\s*units|qty\s*total|quantity\s*total|grand\s*total\s*qty|total\s*no\.?\s*of\s*pcs)\s*:?$/i;

/**
 * The cells of a line split into single words, each with the span it took.
 * A heading the cell reader merged ("Quantity Price") becomes two headings.
 */
function words(cells: readonly GridCell[]): GridCell[] {
  const out: GridCell[] = [];
  for (const c of cells) {
    const text = c.text.trim();
    const parts = text.split(/\s+/);
    if (parts.length === 1) { out.push({ text, x: c.x, end: c.end }); continue; }
    const per = (c.end - c.x) / Math.max(1, text.length);
    let offset = 0;
    for (const p of parts) {
      const start = text.indexOf(p, offset);
      out.push({ text: p, x: c.x + start * per, end: c.x + (start + p.length) * per });
      offset = start + p.length;
    }
  }
  return out;
}

interface Heading {
  index: number;
  sizes: Array<{ label: string; centre: number; x: number; end: number }>;
  qty: number | null;
  price: number | null;
  amount: number | null;
}

/** Group heading words that belong together ("Youth" + "S", "Unit" + "Price"). */
function headingTokens(cells: readonly GridCell[]): GridCell[] {
  // Prefer whole cells that are sizes or labels; split the rest into words.
  const out: GridCell[] = [];
  for (const c of cells) {
    const t = c.text.trim();
    if (isSizeLabel(t) || QTY_WORDS.test(t) || PRICE_WORDS.test(t) || TOTAL_WORDS.test(t)) out.push({ ...c, text: t });
    else out.push(...words([c]));
  }
  return out;
}

/**
 * A size heading: two or more size labels in a row, set left to right, and
 * either a letter size among them or a Quantity/Total heading beside them —
 * a line of bare numbers is far more often data than a heading.
 */
export function readHeading(cells: readonly GridCell[], index = 0): Heading | null {
  const tokens = headingTokens(cells);
  const sizes: Heading['sizes'] = [];
  let qty: number | null = null, price: number | null = null, amount: number | null = null;
  let other = 0;
  for (const t of tokens) {
    const centre = (t.x + t.end) / 2;
    if (QTY_WORDS.test(t.text) && qty == null) qty = centre;
    else if (PRICE_WORDS.test(t.text) && price == null) price = centre;
    else if (TOTAL_WORDS.test(t.text) && amount == null) amount = centre;
    else if (isSizeLabel(t.text) && qty == null && price == null && amount == null) sizes.push({ label: t.text, centre, x: t.x, end: t.end });
    else other++;
  }
  if (sizes.length < 2) return null;
  const lettered = sizes.some((s) => !/^\d{1,3}$/.test(s.label));
  if (!lettered && qty == null && amount == null) return null;
  // Words that are neither sizes nor headings (a description column) are fine
  // in moderation; a sentence that happens to contain "S" and "M" is not a heading.
  if (other > sizes.length + 3) return null;
  // "Total" with no price beside it is the quantity column.
  if (amount != null && price == null && qty == null) { qty = amount; amount = null; }
  return { index, sizes, qty, price, amount };
}

// ── Grids ───────────────────────────────────────────────────────────────────

/** The column a number sits under: the nearest centre, close enough to it. */
function columnOf(cell: GridCell, centres: readonly number[], reach: number): number {
  const c = (cell.x + cell.end) / 2;
  let best = -1, dist = Infinity;
  centres.forEach((x, i) => { const d = Math.abs(x - c); if (d < dist) { dist = d; best = i; } });
  return dist <= reach ? best : -1;
}

const STYLE_TITLE = /^(.*?)\s*\(\s*([A-Za-z0-9][\w./-]{2,})\s*\)\s*$/;
const STYLE_LABEL = /^(style|article|art\.?|item|model|ref\.?)\s*(no\.?|number|#|code)?\s*[:#]?\s*(.+)$/i;

/** The style a grid belongs to: the nearest title above it, "Name (CODE)" preferred. */
function styleAbove(lines: readonly GridLine[], from: number, stop: number): { style: string | null; code: string | null } {
  let fallback: { style: string | null; code: string | null } | null = null;
  for (let i = from - 1; i > stop && i >= from - 8; i--) {
    const text = lines[i]!.cells.map((c) => c.text).join(' ').trim();
    const m = STYLE_TITLE.exec(text);
    if (m && m[1]) return { style: m[1].trim(), code: m[2]! };
    const l = STYLE_LABEL.exec(text);
    if (l && !fallback) fallback = { style: null, code: l[3]!.trim().split(/\s+/)[0]! };
  }
  return fallback ?? { style: null, code: null };
}

/**
 * Every size grid in the document.
 *
 * A grid runs from its heading to its "Total" line, the next heading, or the
 * end of its page. Inside it, each line with a label left of the size columns
 * is a colour; each number under a size column joins the colour nearest it in
 * height (within a line's spacing), so quantities printed a few points off the
 * colour's baseline — or on the line above or below — still land in its row.
 */
export function readSizeGrids(lines: readonly GridLine[]): GridBlock[] {
  const headings: Heading[] = [];
  lines.forEach((l, i) => { const h = readHeading(l.cells, i); if (h) headings.push(h); });
  const blocks: GridBlock[] = [];

  for (const [hi, h] of headings.entries()) {
    const page = lines[h.index]!.page;
    const nextHeading = headings[hi + 1]?.index ?? lines.length;
    const centres = h.sizes.map((s) => s.centre);
    const gaps = centres.slice(1).map((c, i) => c - centres[i]!);
    const reach = Math.max(8, Math.min(...gaps, 60) / 2);
    const firstSizeX = Math.min(...h.sizes.map((s) => s.x));

    // The lines of the grid.
    const body: GridLine[] = [];
    let totalLine: GridLine | null = null;
    for (let i = h.index + 1; i < nextHeading; i++) {
      const line = lines[i]!;
      if (line.page !== page) break;
      const label = line.cells.find((c) => c.end <= firstSizeX + 2)?.text.trim() ?? '';
      if (ROW_TOTAL.test(label) || PIECES_LINE.test(label)) { totalLine = line; break; }
      // A new style title ends the grid.
      if (STYLE_TITLE.test(line.cells.map((c) => c.text).join(' ').trim()) && !line.cells.some((c) => pieces(c.text) != null && c.x >= firstSizeX)) break;
      body.push(line);
    }

    // Colours: labels left of the size columns.
    type Anchor = { y: number; colour: string; cells: Record<string, number>; printedQty: number | null; price: number | null; amount: number | null };
    const anchors: Anchor[] = [];
    for (const line of body) {
      const labels = line.cells.filter((c) => c.end <= firstSizeX + 2).map((c) => c.text.trim()).filter(Boolean);
      // A colour code beside the name ("Black/Yellow 020") is dropped from the name.
      const named = labels.filter((t) => !/^\d{1,4}$/.test(t) && !BARCODE.test(t));
      const colour = (named.length > 0 ? named : labels).join(' ').replace(/\s+/g, ' ').trim();
      if (colour && !/^[:.\-–—]+$/.test(colour)) anchors.push({ y: line.y, colour, cells: {}, printedQty: null, price: null, amount: null });
    }

    // Numbers under the size columns, and the row's quantity / price / amount.
    const stray: Array<{ y: number; size: string; qty: number }> = [];
    const extras: Array<{ y: number; kind: 'qty' | 'price' | 'amount'; value: number }> = [];
    for (const line of body) {
      for (const cell of words(line.cells)) {
        if (cell.end <= firstSizeX + 2) continue;
        const centre = (cell.x + cell.end) / 2;
        if (BARCODE.test(cell.text.trim())) continue;
        // Whichever column the number is nearest: a size, or the row's own
        // quantity, price or amount.
        const near = (x: number | null) => (x == null ? Infinity : Math.abs(x - centre));
        const dq = near(h.qty), dp = near(h.price), da = near(h.amount);
        const min = Math.min(dq, dp, da);
        const sizeDist = Math.min(...centres.map((c) => Math.abs(c - centre)));
        if (sizeDist <= min) {
          const col = columnOf(cell, centres, reach);
          const n = pieces(cell.text);
          if (col >= 0 && n != null && n > 0) stray.push({ y: line.y, size: h.sizes[col]!.label, qty: n });
          continue;
        }
        const v = parseAmount(cell.text);
        if (v == null || min > 60) continue;
        extras.push({ y: line.y, kind: min === dq ? 'qty' : min === dp ? 'price' : 'amount', value: v });
      }
    }

    // A grid of quantities with no colour label at all is one colour.
    if (anchors.length === 0 && stray.length > 0) {
      anchors.push({ y: stray[0]!.y, colour: 'As ordered', cells: {}, printedQty: null, price: null, amount: null });
    }
    const nearest = (y: number) => {
      let best: Anchor | null = null, dist = Infinity;
      for (const a of anchors) { const d = Math.abs(a.y - y); if (d < dist) { dist = d; best = a; } }
      // Within about one printed line of the colour.
      return dist <= 14 ? best : null;
    };
    const problems: string[] = [];
    let lost = 0;
    for (const s of stray) {
      const a = nearest(s.y);
      if (!a) { lost += s.qty; continue; }
      a.cells[s.size] = (a.cells[s.size] ?? 0) + s.qty;
    }
    for (const e of extras) {
      const a = nearest(e.y);
      if (!a) continue;
      if (e.kind === 'qty' && a.printedQty == null) a.printedQty = e.value;
      if (e.kind === 'price' && a.price == null) a.price = e.value;
      if (e.kind === 'amount' && a.amount == null) a.amount = e.value;
    }
    if (lost > 0) problems.push(`${lost} pcs printed under the sizes could not be matched to a colour.`);

    const rows: GridRow[] = anchors
      .map((a) => ({ ...a, total: Object.values(a.cells).reduce((x, y) => x + y, 0) }))
      .filter((a) => a.total > 0 || a.printedQty != null)
      .map(({ colour, cells, total, printedQty, price, amount }) => ({ colour, cells, total, printedQty, price, amount }));

    for (const r of rows) {
      if (r.printedQty != null && r.printedQty !== r.total) {
        problems.push(`${r.colour}: the sizes add up to ${r.total} pcs but the row says ${r.printedQty}.`);
      }
      // Quantity × price must be the amount, to the cent.
      const qty = r.printedQty ?? r.total;
      if (r.price != null && r.amount != null && Math.abs(qty * r.price - r.amount) > 0.011) {
        problems.push(`${r.colour}: ${qty} pcs × ${r.price} is not the printed ${r.amount}.`);
      }
    }

    // The grid's own total line.
    let printedTotal: number | null = null;
    if (totalLine) {
      const nums = words(totalLine.cells)
        .filter((c) => c.end > firstSizeX)
        .map((c) => ({ c, n: pieces(c.text) }))
        .filter((v): v is { c: GridCell; n: number } => v.n != null);
      const qtyCell = h.qty != null ? nums.find((v) => Math.abs((v.c.x + v.c.end) / 2 - h.qty!) <= 40) : null;
      printedTotal = qtyCell?.n ?? null;
      if (printedTotal == null) {
        const sizeSum = nums.filter((v) => columnOf(v.c, centres, reach) >= 0).reduce((a, v) => a + v.n, 0);
        printedTotal = sizeSum > 0 ? sizeSum : null;
      }
      const read = rows.reduce((a, r) => a + r.total, 0);
      if (printedTotal != null && printedTotal !== read) problems.push(`The grid's total line says ${printedTotal} pcs; the colours read add up to ${read}.`);
    }

    if (rows.length === 0) continue;
    const used = new Set(rows.flatMap((r) => Object.keys(r.cells)));
    const prevEnd = hi > 0 ? headings[hi - 1]!.index : -1;
    const { style, code } = styleAbove(lines, h.index, prevEnd);
    blocks.push({
      style, styleCode: code,
      sizes: h.sizes.map((s) => s.label).filter((s) => used.has(s)),
      rows, printedTotal, problems,
    });
  }
  return blocks;
}

// ── Grids into an order ─────────────────────────────────────────────────────

export interface GridOrder {
  matrix: { sizes: string[]; rows: Array<{ color: string; cells: Record<string, number>; total: number }> };
  orderName: string | null;
  styleNumber: string | null;
  pricePerPiece: number | null;
  pricesVary: boolean;
  totalQty: number;
  totalValue: number | null;
  styles: string[];
  lineItems: Array<{ description: string; quantity: number; unit: string; unitPrice: number | null; rowNumber: number }>;
  problems: string[];
}

/**
 * One order from every grid. Sizes keep the document's own labels and order;
 * with several styles each colour row is named "Style — Colour", because an
 * order holds a colour once and two styles may share one.
 */
export function gridsToOrder(blocks: readonly GridBlock[]): GridOrder | null {
  if (blocks.length === 0) return null;
  const styleKey = (b: GridBlock, i: number) => b.style ?? b.styleCode ?? `Style ${i + 1}`;
  const styles = [...new Set(blocks.map(styleKey))];
  const multi = styles.length > 1;

  const sizes: string[] = [];
  for (const b of blocks) for (const s of b.sizes) if (!sizes.some((x) => x.toUpperCase() === s.toUpperCase())) sizes.push(s);
  const canon = (s: string) => sizes.find((x) => x.toUpperCase() === s.toUpperCase()) ?? s;

  const rows = new Map<string, Record<string, number>>();
  const lineItems: GridOrder['lineItems'] = [];
  let value = 0, priced = 0;
  const prices = new Set<number>();
  for (const [i, b] of blocks.entries()) {
    for (const r of b.rows) {
      const name = multi ? `${styleKey(b, i)} — ${r.colour}` : r.colour;
      const cells = rows.get(name) ?? {};
      for (const [s, q] of Object.entries(r.cells)) cells[canon(s)] = (cells[canon(s)] ?? 0) + q;
      rows.set(name, cells);
      if (r.price != null) {
        prices.add(r.price);
        value += r.amount ?? r.total * r.price;
        priced += r.total;
      }
      lineItems.push({
        description: [b.style, b.styleCode ? `(${b.styleCode})` : null, r.colour].filter(Boolean).join(' '),
        quantity: r.total, unit: 'PCS', unitPrice: r.price, rowNumber: lineItems.length + 1,
      });
    }
  }
  const matrixRows = [...rows].map(([color, cells]) => ({ color, cells, total: Object.values(cells).reduce((a, b) => a + b, 0) }));
  const totalQty = matrixRows.reduce((a, r) => a + r.total, 0);
  const codes = [...new Set(blocks.map((b) => b.styleCode).filter(Boolean))] as string[];
  const names = [...new Set(blocks.map((b) => b.style).filter(Boolean))] as string[];
  return {
    matrix: { sizes, rows: matrixRows },
    orderName: names.length === 1 ? names[0]! : null,
    styleNumber: codes.length === 1 ? codes[0]! : null,
    pricePerPiece: prices.size === 1 ? [...prices][0]!
      : priced > 0 ? Math.round((value / priced) * 10000) / 10000 : null,
    pricesVary: prices.size > 1,
    totalQty,
    totalValue: priced > 0 ? Math.round(value * 100) / 100 : null,
    styles,
    lineItems,
    problems: blocks.flatMap((b) => b.problems),
  };
}

/**
 * The document's own count of pieces, where it prints one: "Pieces 32",
 * "Total quantity: 1,972", "Total pcs 408". The strongest check there is on a
 * reading, since it is written by the buyer independently of every row.
 */
export function readPrintedPieces(lines: readonly GridLine[]): number | null {
  const LABEL = /^(pieces|total\s*pieces|total\s*pcs|total\s*qty|total\s*quantity|total\s*units|qty\s*total|quantity\s*total|grand\s*total\s*qty|total\s*no\.?\s*of\s*pcs)\s*:?$/i;
  for (const l of lines) {
    for (const [i, c] of l.cells.entries()) {
      const text = c.text.trim();
      const m = /^(.*?)\s*:?\s*([\d.,]+)\s*(pcs|pieces|units)?$/i.exec(text);
      if (m && LABEL.test(m[1]!.trim())) { const n = pieces(m[2]!); if (n != null && n > 0) return n; }
      if (LABEL.test(text)) {
        const next = l.cells[i + 1]?.text.trim().replace(/\s*(pcs|pieces|units)$/i, '');
        const n = next ? pieces(next) : null;
        if (n != null && n > 0) return n;
      }
    }
  }
  return null;
}
