/**
 * Generic tabular extraction — the universal importer.
 *
 * The profile-based extractor next door reads one workbook shape very well, by
 * finding labelled anchors on named sheets. That is the right tool for a file
 * the factory controls. It is the wrong tool for a file a customer emails,
 * because that file has whatever headers the customer felt like typing.
 *
 * This reads the other kind. It finds the table in an arbitrary sheet, works
 * out what each column means using the synonym engine in @opsflow/shared, and
 * produces **the same `ExtractionResult`** the profile extractor produces — so
 * the preview screen, the validation, and the transactional commit are all
 * unchanged. The universal importer is a new way in, not a second pipeline.
 *
 * Two table shapes are handled, because customers send both:
 *
 *   LONG    one row per colour/size/quantity
 *           Style | Color | Size | Qty
 *
 *   WIDE    one row per colour, one column per size — the classic size grid
 *           Color  | XS | S | M | L | XL
 *
 * Detecting which is which is the interesting part, and it is done from the
 * data rather than from the headers: a run of adjacent columns whose headers
 * are size tokens and whose cells are numbers is a size grid, whatever the
 * sheet is called.
 */

import ExcelJS from 'exceljs';
import {
  ImportConcept, analyseColumns, assessMapping, normaliseHeader, CONCEPT_SYNONYMS,
  CONCEPT_META, ANALYSIS_CHECKLIST,
  type ColumnAnalysis,
} from '@opsflow/shared';
import type { ImportIssue, ImportSheetInfo } from '@opsflow/shared';
import type { ExtractionResult, ExtractedMatrix } from './extractor.js';
import { detectFileKind } from './file-kind.js';
import { cellText, toNumber, toDate, buildLineItems, parseFieldOverride } from './extractor.js';
import { toIsoDayOrNull } from '@opsflow/shared';
import { loadWorkbook, readCsvWorkbook } from './open-workbook.js';
import { readAgeLayingSheet } from './age-laying-reader.js';
import { orderSizes, splitColourSize } from './po-lines.js';

// ─────────────────────────────────────────────────────────────────────────────
// Sheet reading
// ─────────────────────────────────────────────────────────────────────────────

/** A rectangle of raw values, with the header row identified. */
export interface SheetTable {
  sheetName: string;
  headerRowIndex: number;
  headers: string[];
  rows: unknown[][];
  /** How table-like this sheet looked. Used to pick the best sheet. */
  score: number;
}

function rawValue(cell: ExcelJS.Cell | undefined): unknown {
  if (!cell) return null;
  const v = cell.value;
  if (v == null) return null;
  if (typeof v === 'object' && 'result' in (v as object)) return (v as { result: unknown }).result;
  if (typeof v === 'object' && 'richText' in (v as object)) return cellText(v);
  return v;
}

// A customer order can run to hundreds of rows — 450 was cut to 399 colours at
// the old limit of 400 with no word said. Five thousand covers any order, and
// a sheet longer than that is reported rather than silently shortened.
const MAX_SCAN_ROWS = 5000;
const MAX_SCAN_COLS = 60;

/**
 * The fewest columns a header row can have.
 *
 * Three, because a customer file's title block is written as `Label | value`
 * pairs — "Purchase Order | PO-99001" over "Delivery Date | 2026-09-15" — and
 * that is indistinguishable from a two-column table followed by its data. It
 * costs nothing to rule out: an order needs a colour, a size and a quantity, so
 * a genuine two-column order table cannot exist.
 */
/**
 * Two, not three.
 *
 * Three was safe when every document was a colour × size grid. A proforma that
 * states one price at the top and then lists "Description | Quantity" is two
 * columns wide and was invisible — no header candidate, no table, no invoice
 * lines. The guards that actually keep a caption block from being read as a
 * header are the numeric test, the colon test and the requirement that the row
 * beneath be populated; the width was never the thing doing that work.
 */
const MIN_HEADER_COLUMNS = 2;

/**
 * Rows that could plausibly be the header.
 *
 * Spreadsheets from customers rarely start at A1 — there is a logo, a title
 * block, a blank row, then the table. Rather than taking the first plausible
 * row, every candidate is scored as a table and the best one wins, because
 * "first" and "best" are not the same row in a file with a title block.
 */
export function findHeaderCandidates(sheet: ExcelJS.Worksheet): number[] {
  const limit = Math.min(sheet.rowCount || MAX_SCAN_ROWS, 30);
  const candidates: number[] = [];

  for (let r = 1; r <= limit; r++) {
    const row = sheet.getRow(r);
    const cells: Array<{ col: number; text: string }> = [];

    for (let c = 1; c <= Math.min(sheet.columnCount || MAX_SCAN_COLS, MAX_SCAN_COLS); c++) {
      const text = String(cellText(rawValue(row.getCell(c)))).trim();
      if (text) cells.push({ col: c, text });
    }
    if (cells.length < MIN_HEADER_COLUMNS) continue;

    // Headers are labels, not measurements: a row that is mostly numbers is
    // data, however early it appears.
    //
    // Except when the numbers *are* the headings. Waist sizes, shoe sizes and
    // children's ages are all numeric — "Colour | 28 | 30 | 32" is a perfectly
    // ordinary size grid, and this rule threw the whole sheet away: no header,
    // no colours, no quantities, nothing read at all.
    //
    // A data row and a size-header row have the same shape (one label, then
    // numbers), so shape cannot tell them apart. What can is the first cell:
    // a header begins with a column name — "Colour", "Article" — and a data row
    // begins with a value, "Navy". Scoring already prefers the real header once
    // both are candidates; this only stops one being discarded before scoring.
    const numeric = cells.filter((x) => /^-?[\d,.\s]+$/.test(x.text)).length;
    const namedFirstCell = cells.length > 0 && isKnownLabel(cells[0]!.text);
    if (numeric > cells.length / 2 && !namedFirstCell) continue;

    // A caption block is not a table header.
    //
    // "PO Number: | PI-103 | Customer: | Meyba" is the facts stated above a
    // document, and it scores well as a header because those *are* concept
    // names. It was being chosen over the real table below it, and the row
    // beneath a caption block is the next caption — so the PO number came out
    // as "Unit price:" and the invoice had no lines at all.
    //
    // A column heading does not end in a colon. Two or more that do means this
    // row is labelling values beside it, not naming columns under it.
    const captions = cells.filter((x) => /:\s*$/.test(x.text)).length;
    if (captions >= 2) continue;

    // The data must start under the header — but not necessarily on the very
    // next row. A buyer's load-build template puts one cell on the row after
    // the headings (its vendor number) and the item rows below that; judged on
    // that one row alone the real header was discarded, the first item row
    // became the header, and its "144" and "3" became size columns. The best
    // of the next three rows is what the header is judged on.
    let populated = 0;
    for (let below = r + 1; below <= Math.min(r + 3, sheet.rowCount || MAX_SCAN_ROWS); below++) {
      const next = sheet.getRow(below);
      const count = cells.filter((x) => {
        const v = rawValue(next.getCell(x.col));
        return v != null && String(cellText(v)).trim() !== '';
      }).length;
      populated = Math.max(populated, count);
    }

    // Judged against the headings that exist, lightly: the same template has
    // twenty-three headings and fills five of them per item (the rest are the
    // buyer's own bookkeeping), and at four in ten the real header never
    // qualified. Scoring, not this bar, is what picks the right row among the
    // candidates; this only keeps a caption with nothing under it out.
    if (populated >= Math.max(2, Math.ceil(cells.length * 0.15))) candidates.push(r);
  }
  return candidates;
}

/** "Proforma invoice" in the first forty rows of a sheet names the document. */
function looksLikeProforma(sheet: ExcelJS.Worksheet): boolean {
  const limit = Math.min(sheet.rowCount || 0, 40);
  for (let r = 1; r <= limit; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= Math.min(sheet.columnCount || MAX_SCAN_COLS, MAX_SCAN_COLS); c++) {
      const text = String(cellText(rawValue(row.getCell(c)))).trim().toLowerCase();
      // A title, not a mention: a laying sheet's notes may say "as per the
      // proforma invoice" in a long cell and are not one.
      if (text.length <= 80 && /pro\s*-?\s*forma\s+invoice/.test(text)) return true;
    }
  }
  return false;
}

/**
 * Read one sheet as a table, if it looks like one.
 *
 * Tries each candidate header row and keeps whichever produces the most
 * recognisable table. A title block above the data no longer wins simply by
 * being first.
 */
export function readSheetTable(sheet: ExcelJS.Worksheet): SheetTable | null {
  let best: SheetTable | null = null;

  // Only the first few candidates are worth trying: past that we are reading
  // rows of the table itself as though they were its header.
  for (const candidate of findHeaderCandidates(sheet).slice(0, 5)) {
    const table = readTableAt(sheet, candidate);
    if (table && (!best || table.score > best.score)) best = table;
  }
  return best;
}

/**
 * Read one specific row as a table's header, regardless of how it scores.
 *
 * Exported so a caller with its own concept set (see laying-extractor.ts)
 * can pick the best header row by ITS OWN scoring instead of `scoreTable`
 * below, which is weighted toward order-matrix concepts (colour, size,
 * quantity) and is the wrong judge for a differently-shaped table.
 */
export function readTableAt(sheet: ExcelJS.Worksheet, headerRowIndex: number): SheetTable | null {
  const headerRow = sheet.getRow(headerRowIndex);
  const allHeaders: string[] = [];
  const allColumns: number[] = [];

  let lastPopulated = 0;
  for (let c = 1; c <= Math.min(sheet.columnCount || MAX_SCAN_COLS, MAX_SCAN_COLS); c++) {
    const text = String(cellText(rawValue(headerRow.getCell(c)))).trim();
    allHeaders.push(text);
    allColumns.push(c);
    if (text) lastPopulated = c;
  }
  allHeaders.length = lastPopulated;
  allColumns.length = lastPopulated;

  // The heading sequence — the non-blank headings in order — is what a block
  // of this table is recognised by, wherever it sits.
  const sequence = allHeaders.map((h, i) => ({ text: h.toLowerCase(), i })).filter((h) => h.text !== '');
  const sequenceTexts = sequence.map((h) => h.text);

  // Side by side: the same headings again further along the header row —
  // "Product Name | Color | Size | Qty | | Product Name | Color | Size | Qty".
  // The first run is the table; each later run is the same table beside it,
  // read with its own columns and appended. Found before the columns are cut.
  const sideStarts: number[] = [];
  if (sequenceTexts.length >= 2) {
    let n = sequenceTexts.length;
    // The shortest prefix of the sequence that repeats is the real heading.
    for (let len = 1; len * 2 <= sequenceTexts.length; len++) {
      const prefix = sequenceTexts.slice(0, len).join('\u0001');
      let ok = sequenceTexts.length % len === 0;
      for (let k = len; ok && k < sequenceTexts.length; k += len) ok = sequenceTexts.slice(k, k + len).join('\u0001') === prefix;
      if (ok) { n = len; break; }
    }
    if (n < sequenceTexts.length) for (let k = n; k < sequenceTexts.length; k += n) sideStarts.push(k);
    sequence.length = n;
    sequenceTexts.length = n;
  }
  const primaryEnd = sideStarts.length > 0 ? sequence[sequence.length - 1]!.i : allHeaders.length - 1;
  const headers = allHeaders.slice(0, primaryEnd + 1);
  const columns = allColumns.slice(0, primaryEnd + 1);

  /** The sheet columns to read each primary column from, for a block whose headings sit in `cols` (one per heading). */
  const mappingFor = (cols: number[]): Array<number | null> =>
    headers.map((h, i) => {
      if (!h) return null;
      const k = sequence.findIndex((q) => q.i === i);
      return k === -1 ? null : cols[k] ?? null;
    });
  const identity: Array<number | null> = columns.map((c) => c);
  const sideMappings = sideStarts.map((k) => {
    const fullSequence = allHeaders.map((h, i) => ({ text: h.toLowerCase(), i })).filter((h) => h.text !== '');
    return mappingFor(fullSequence.slice(k, k + sequence.length).map((q) => allColumns[q.i]!));
  });

  // Group headings above the sizes. A grid with "Youth" over S M L and
  // "Adult" over the next S M L — merged cells, or the word in the first
  // column of each group — has six sizes, not three repeated: the heading
  // the row above gives each column is carried down into the size label.
  if (headerRowIndex > 1) {
    const sizeLabels = headers.filter((h) => h && looksLikeSize(h)).map((h) => h.toLowerCase());
    const repeated = new Set(sizeLabels).size < sizeLabels.length;
    if (repeated) {
      const above = sheet.getRow(headerRowIndex - 1);
      let group = '';
      for (let i = 0; i < headers.length; i++) {
        const g = String(cellText(rawValue(above.getCell(columns[i]!)))).trim();
        if (g) group = g;
        if (group && headers[i] && looksLikeSize(headers[i]!) && !/^\d+$/.test(g) && group.length <= 20) headers[i] = `${group} ${headers[i]}`;
      }
    }
  }

  const last = Math.min(sheet.rowCount || MAX_SCAN_ROWS, MAX_SCAN_ROWS);

  // A sheet written one block per style — the header row again, the rows,
  // a total — is one table in four pieces. Read to the first total, it was
  // one style of four: 579 pieces of a 1,972-piece order. Every repeat of the
  // header row is found first, so a total followed by another block is a
  // divider rather than the end. A repeat is known by its headings, not its
  // columns: a block pasted one column to the right is still this table.
  const repeats = new Map<number, Array<number | null>>();
  const maxCol = Math.min(sheet.columnCount || MAX_SCAN_COLS, MAX_SCAN_COLS);
  for (let r = headerRowIndex + 1; r <= last; r++) {
    const row = sheet.getRow(r);
    const filled: Array<{ text: string; c: number }> = [];
    for (let c = 1; c <= maxCol; c++) {
      const text = String(cellText(rawValue(row.getCell(c)))).trim().toLowerCase();
      if (text) filled.push({ text, c });
    }
    if (filled.length !== sequenceTexts.length || sequenceTexts.length === 0) continue;
    if (filled.every((f, k) => f.text === sequenceTexts[k])) repeats.set(r, mappingFor(filled.map((f) => f.c)));
  }
  const lastRepeat = repeats.size > 0 ? Math.max(...repeats.keys()) : 0;

  const rows: unknown[][] = [];
  const sideRows: unknown[][][] = sideMappings.map(() => []);
  let mapping = identity;
  let blankRun = 0;

  const read = (row: ExcelJS.Row, m: Array<number | null>): unknown[] => m.map((c) => (c == null ? null : rawValue(row.getCell(c))));
  const isFilled = (v: unknown) => v != null && String(cellText(v)).trim() !== '';

  for (let r = headerRowIndex + 1; r <= last; r++) {
    const repeat = repeats.get(r);
    if (repeat) { mapping = repeat; blankRun = 0; continue; }
    const row = sheet.getRow(r);
    const values = read(row, mapping);
    const populated = values.filter(isFilled).length;

    if (populated === 0) {
      // A gap is normal in a hand-maintained sheet; ten in a row is the end.
      if (++blankRun >= 10) break;
      // A gap and then a title — one cell of words, "Bill of materials" — is
      // the start of another table, not more of this one. Its rows were read
      // as colours called "Jersey fabric" and "Thread".
      const next = nextPopulated(sheet, r + 1, Math.min(r + 10, last), columns);
      if (next && next.populated === 1 && next.firstText && toNumber(next.firstText) == null && !repeats.has(next.row)) break;
      continue;
    }
    blankRun = 0;

    // A totals row is a summary of the data, not part of it. Importing it
    // doubles the order. Judged by the row's first *filled* cell, not column
    // A: a table that starts in column B has its "Total" label there, and
    // reading the blank A cell let the totals through as one more colour.
    // With another block of the same table still to come, it is skipped
    // rather than ending the read.
    const firstFilled = values.find(isFilled);
    if (isTotalsLabel(firstFilled)) { if (r < lastRepeat) continue; break; }

    rows.push(values);
    sideMappings.forEach((m, k) => {
      const side = read(row, m);
      if (side.filter(isFilled).length === 0) return;
      if (isTotalsLabel(side.find(isFilled))) return;
      sideRows[k]!.push(side);
    });
  }

  for (const side of sideRows) rows.push(...side);
  if (rows.length === 0) return null;

  return {
    sheetName: sheet.name,
    headerRowIndex,
    headers,
    rows,
    score: scoreTable(headers, rows),
  };
}

/** The next row with anything in it, and what it holds. */
function nextPopulated(sheet: ExcelJS.Worksheet, from: number, to: number, columns: number[]): { row: number; populated: number; firstText: string } | null {
  for (let r = from; r <= to; r++) {
    const row = sheet.getRow(r);
    const texts = columns.map((c) => String(cellText(rawValue(row.getCell(c)))).trim()).filter((t) => t !== '');
    if (texts.length > 0) return { row: r, populated: texts.length, firstText: texts[0]! };
  }
  return null;
}

/** "Total", "Grand total", "Subtotal", "Sum" — a row that restates the others. */
function isTotalsLabel(value: unknown): boolean {
  const text = String(cellText(value)).trim().toLowerCase();
  return /^(total|totals|grand total|sum|sub\s*total)\b/.test(text);
}

/**
 * How likely this sheet is to be *the* order table.
 *
 * A workbook often has several sheets that parse as tables — a price list, a
 * size chart, a notes tab. The one that matters is the one carrying colours,
 * sizes and quantities, so recognised essential concepts count for far more
 * than raw size.
 */
function scoreTable(headers: readonly string[], rows: readonly unknown[][]): number {
  const analyses = analyseColumns(headers, rows.slice(0, 20));
  const found = new Set(analyses.filter((a) => a.confidence >= 0.6).map((a) => a.concept));

  let score = 0;
  if (found.has(ImportConcept.QUANTITY)) score += 3;
  if (found.has(ImportConcept.COLOR)) score += 3;
  if (found.has(ImportConcept.SIZE)) score += 3;
  if (found.has(ImportConcept.STYLE) || found.has(ImportConcept.ARTICLE)) score += 2;
  if (found.has(ImportConcept.PO_NUMBER)) score += 1;

  // A wide size grid has no "Size" column at all — its sizes are the headers.
  if (!found.has(ImportConcept.SIZE) && detectSizeColumns(headers, rows).length >= 3) score += 3;

  score += Math.min(2, rows.length / 25);
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wide (size-grid) detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Size tokens as garment factories write them.
 *
 * A pattern rather than a list, so YXS, 2XL, 3XL, 38 and "XXL" all qualify
 * without maintenance.
 */
const SIZE_TOKEN = /^(?:\d?\s?[axy]{0,3}(?:xs|s|m|l|xl|xxl|xxxl)|[0-9]{1,3}(?:\/[0-9]{1,3})?|os|one size|free)$/i;

/**
 * The same sizes spelled out.
 *
 * Not a nicety: a size grid headed "Medium | Large | XL" is exactly what a
 * customer who is not in the garment trade sends, and the abbreviation-only
 * pattern above read it as three unrecognised columns and found no matrix at
 * all. Kept as an explicit list because "small" must match and "smaller",
 * "small parts" and "small carton" must not.
 */
const SPELLED_SIZES = new Set([
  'xsmall', 'extrasmall', 'small', 'medium', 'large',
  'xlarge', 'extralarge', 'xxlarge', 'xxxlarge',
  'youthsmall', 'youthmedium', 'youthlarge',
  'onesize', 'freesize',
]);

export function looksLikeSize(header: string): boolean {
  // "Youth S", "Adult XL": the group names who it is for; the size is the rest.
  const h = normaliseHeader(header).replace(/^(youth|yth|adult|adt|kids?|children|junior|jr|mens?|womens?|ladies|boys|girls|infant|toddler)\s+/, '').replace(/\s+/g, '');
  if (!h) return false;
  if (SPELLED_SIZES.has(h.replace(/-/g, ''))) return true;
  if (h.length > 6) return false;
  return SIZE_TOKEN.test(h);
}

/**
 * Find a run of adjacent columns that are a size grid.
 *
 * Both halves matter: the headers must look like sizes, *and* the cells beneath
 * them must be mostly numbers. A "Size" column of the word "Medium" is not a
 * grid, and a column headed "L" holding "Leather" is not a size.
 */
export function detectSizeColumns(
  headers: readonly string[],
  rows: readonly unknown[][],
): Array<{ index: number; name: string }> {
  const candidates: Array<{ index: number; name: string }> = [];

  headers.forEach((h, index) => {
    if (!h?.trim() || !looksLikeSize(h)) return;
    const values = rows.slice(0, 30).map((r) => r[index]).filter((v) => v != null && String(v).trim() !== '');
    if (values.length === 0) return;
    const numeric = values.filter((v) => toNumber(v) != null).length;
    if (numeric / values.length >= 0.8) candidates.push({ index, name: h.trim() });
  });

  if (candidates.length < 2) return [];

  // Keep the longest adjacent run: scattered single columns that happen to be
  // called "M" and "L" elsewhere on the sheet are not part of the grid.
  let best: typeof candidates = [];
  let run: typeof candidates = [];
  for (let i = 0; i < candidates.length; i++) {
    if (i === 0 || candidates[i]!.index === candidates[i - 1]!.index + 1) {
      run.push(candidates[i]!);
    } else {
      if (run.length > best.length) best = run;
      run = [candidates[i]!];
    }
  }
  if (run.length > best.length) best = run;

  return best.length >= 2 ? best : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Building the matrix
// ─────────────────────────────────────────────────────────────────────────────

interface BuildContext {
  table: SheetTable;
  analyses: ColumnAnalysis[];
  issues: ImportIssue[];
}

const columnFor = (analyses: readonly ColumnAnalysis[], concept: ImportConcept): number | null =>
  analyses.find((a) => a.concept === concept)?.index ?? null;

/**
 * LONG layout: one row per colour × size × quantity.
 *
 * With `sizeFromColour`, the sheet has no Size column and the size is read off
 * the end of the colour text instead — "HUNTER/WHT YOUTH SMALL" is colour
 * HUNTER/WHT in size Youth Small. That is how a buyer's ERP writes a SKU
 * description, and a file written that way was reading as nothing at all. It
 * is taken only when most rows yield a size, so a plain colour list is not
 * carved up by accident.
 *
 * A file with several styles names each row "Style — Colour": the same
 * NAVY/RED under two shirts is two products, and an order colour is unique by
 * name. A row whose description is only a size ("ADULT LARGE", the colour
 * being in the style's own name) is the style.
 */
function buildLongMatrix(ctx: BuildContext, opts: { sizeFromColour?: boolean } = {}): ExtractedMatrix | null {
  const colorCol = columnFor(ctx.analyses, ImportConcept.COLOR);
  const sizeCol = opts.sizeFromColour ? null : columnFor(ctx.analyses, ImportConcept.SIZE);
  const qtyCol = columnFor(ctx.analyses, ImportConcept.QUANTITY);
  const styleCol = columnFor(ctx.analyses, ImportConcept.STYLE);
  if (colorCol == null || qtyCol == null) return null;
  if (sizeCol == null && !opts.sizeFromColour) return null;

  const styles = new Set(
    styleCol == null ? [] : ctx.table.rows.map((r) => String(cellText(r[styleCol])).trim()).filter(Boolean),
  );
  const qualify = styles.size > 1;

  const byColor = new Map<string, Record<string, number>>();
  const sizeOrder: string[] = [];
  let skipped = 0;
  let unsized = 0;
  let example: { text: string; colour: string; size: string } | null = null;

  for (const row of ctx.table.rows) {
    const text = String(cellText(row[colorCol])).trim();
    const qty = toNumber(row[qtyCol]);
    const style = styleCol == null ? '' : String(cellText(row[styleCol])).trim();

    // A row with nothing in the colour, size or quantity cells is not a row
    // that was skipped — it is the vendor number, a spacer, a note. Only a
    // row that held something is worth telling the coordinator about.
    const blank = !text && qty == null && (sizeCol == null || String(cellText(row[sizeCol])).trim() === '');
    if (blank) continue;

    let color = text;
    let size = sizeCol == null ? '' : String(cellText(row[sizeCol])).trim();
    if (opts.sizeFromColour) {
      const split = text ? splitColourSize(text) : { colour: null, size: null };
      if (!split.size) { if (text) unsized++; skipped++; continue; }
      size = split.size;
      color = split.colour ?? '';
      if (!example && split.colour) example = { text, colour: split.colour, size: split.size };
    }
    if (qualify) color = color ? `${style} — ${color}` : style;

    if (!color || !size) { skipped++; continue; }
    if (qty == null || qty <= 0) { skipped++; continue; }

    if (!sizeOrder.includes(size)) sizeOrder.push(size);
    const cells = byColor.get(color) ?? {};
    // The same colour and size on two rows is a split delivery, not a mistake:
    // adding them is what the customer meant.
    cells[size] = (cells[size] ?? 0) + qty;
    byColor.set(color, cells);
  }

  if (byColor.size === 0) return null;
  // Most rows must carry a size for this reading to be the right one.
  if (opts.sizeFromColour && unsized > ctx.table.rows.length / 2) return null;

  if (opts.sizeFromColour) {
    ctx.issues.push({
      level: 'INFO', field: null, sheet: ctx.table.sheetName, cell: null,
      message:
        'The file has no Size column, so the size was read from the end of each colour description'
        + (example ? ` — "${example.text}" is colour ${example.colour} in size ${example.size}.` : '.')
        + (qualify ? ` It lists ${styles.size} styles, so each row is named "Style — Colour".` : ''),
    });
  }

  if (skipped > 0) {
    ctx.issues.push({
      level: 'WARNING', field: null, sheet: ctx.table.sheetName, cell: null,
      message:
        `${skipped} row${skipped === 1 ? ' was' : 's were'} skipped because ${skipped === 1 ? 'it' : 'they'} had no colour, no size, ` +
        `or no quantity. ${byColor.size === 0 ? 0 : [...byColor.values()].reduce((a, c) => a + Object.keys(c).length, 0)} rows were read.`,
    });
  }

  const rows = [...byColor.entries()].map(([color, cells]) => ({
    color,
    cells,
    total: Object.values(cells).reduce((a, b) => a + b, 0),
  }));

  return {
    ledger: 'ORDER',
    sizes: orderSizes(sizeOrder),
    rows,
    sheetTotal: null,
    computedTotal: rows.reduce((a, r) => a + r.total, 0),
  };
}

/** WIDE layout: one row per colour, one column per size. */
/** 1 → A, 27 → AA. For telling a coordinator which column to look at. */
function columnLetter(n: number): string {
  let out = '';
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - m) / 26); }
  return out;
}

function buildWideMatrix(ctx: BuildContext, sizeColumns: Array<{ index: number; name: string }>): ExtractedMatrix | null {
  const colorCol = columnFor(ctx.analyses, ImportConcept.COLOR);
  if (colorCol == null) return null;

  const rows: ExtractedMatrix['rows'] = [];
  for (const row of ctx.table.rows) {
    const color = String(cellText(row[colorCol])).trim();
    if (!color) continue;
    // A totals row that survived the table read — labelled in the colour
    // column rather than the first one — is the grid restated, not a colour.
    if (isTotalsLabel(color)) continue;

    const cells: Record<string, number> = {};
    let total = 0;
    // Words under the sizes mean the grid has ended and another table begun
    // — a bill of materials below the order, its units under S and M. Its
    // rows were read as colours called "Jersey fabric" and "Thread".
    const wordy = sizeColumns.some((s) => { const v = row[s.index]; return v != null && String(cellText(v)).trim() !== '' && toNumber(v) == null; });
    if (wordy) continue;
    for (const s of sizeColumns) {
      const qty = toNumber(row[s.index]);
      if (qty != null && qty > 0) { cells[s.name] = qty; total += qty; }
    }
    if (total > 0) rows.push({ color, cells, total });
  }

  if (rows.length === 0) return null;

  return {
    ledger: 'ORDER',
    sizes: sizeColumns.map((s) => s.name),
    rows,
    sheetTotal: null,
    computedTotal: rows.reduce((a, r) => a + r.total, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Header-block scalars
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick up `Label: value` pairs from the rows above the table.
 *
 * Customer files usually put the PO number and the delivery date in a little
 * block at the top rather than in a column. This scans that block for anything
 * matching a known concept, so the coordinator does not have to retype what is
 * already in the file.
 */
/**
 * Whether a piece of text is a column heading rather than a value.
 *
 * Compared against the synonym table exactly, not fuzzily: a near-miss would
 * reject real values ("Mens" resembling a gender heading), and the only thing
 * worth excluding here is a cell that literally *is* a caption.
 */
function isKnownLabel(text: string): boolean {
  const normalised = normaliseHeader(text).replace(/:\s*$/, '').trim();
  if (!normalised) return false;
  return Object.values(CONCEPT_SYNONYMS).some((list) => list.includes(normalised));
}

function readHeaderBlock(
  sheet: ExcelJS.Worksheet,
  aboveRow: number,
  issues: ImportIssue[],
): Record<string, string | number | Date | null> {
  const found: Record<string, string | number | Date | null> = {};
  if (aboveRow <= 1) return found;

  for (let r = 1; r < aboveRow; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= Math.min(sheet.columnCount || 30, 30); c++) {
      const label = String(cellText(rawValue(row.getCell(c)))).trim();
      if (!label || label.length > 40) continue;

      const guesses = analyseColumns([label], [[null]]);
      const guess = guesses[0]!;
      if (guess.concept === ImportConcept.IGNORE || guess.confidence < 0.8) continue;

      const meta = CONCEPT_META[guess.concept];
      if (!meta.field || found[meta.field] != null) continue;

      // The value sits to the right, or occasionally directly below.
      for (const [dr, dc] of [[0, 1], [0, 2], [1, 0]] as const) {
        const raw = rawValue(sheet.getRow(r + dr).getCell(c + dc));
        if (raw == null || String(cellText(raw)).trim() === '') continue;

        // A caption is not a value.
        //
        // "PURCHASE ORDER" as a document title scores as a PO-number label, and
        // the cell directly below it is the *next* label — "PO Number:" — so the
        // search-below rule read the caption as the order's number. The order
        // was then created as PO "PO Number:", which is the sort of wrong that
        // looks deliberate.
        //
        // Anything ending in a colon, or reading as a known column heading in
        // its own right, is a caption rather than an answer.
        const candidate = String(cellText(raw)).trim();
        if (/:\s*$/.test(candidate)) continue;
        if (isKnownLabel(candidate)) continue;

        const parsed =
          meta.type === 'number' ? toNumber(raw)
          : meta.type === 'date' ? toDate(raw)
          : String(cellText(raw)).trim();

        if (parsed != null && parsed !== '') {
          found[meta.field] = parsed;
          issues.push({
            level: 'INFO', field: meta.field, sheet: sheet.name, cell: null,
            message: `Read ${meta.label} as “${parsed instanceof Date ? (toIsoDayOrNull(parsed) ?? 'an unreadable date') : parsed}” from the sheet header.`,
          });
          break;
        }
      }
    }
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export interface TabularAnalysis {
  /** The sheet chosen, and why. */
  sheetName: string;
  headerRowIndex: number;
  columns: ColumnAnalysis[];
  layout: 'LONG' | 'WIDE' | 'UNKNOWN';
  sizeColumns: string[];
  readiness: ReturnType<typeof assessMapping>;
  /** Every sheet considered, so the coordinator can pick a different one. */
  candidateSheets: Array<{ name: string; score: number; rows: number; headerRowIndex: number }>;
  /** The §5 checklist: concept → found or not. */
  checklist: Array<{ concept: ImportConcept; label: string; detected: boolean; columnHeader: string | null }>;
  rowsDetected: number;
}

export interface TabularExtractionResult extends ExtractionResult {
  analysis: TabularAnalysis;
}

/**
 * Extract an order from an arbitrary workbook.
 *
 * `overrides` is the coordinator's correction from the mapping screen, keyed by
 * column index. It is applied before anything is built, so what they approved
 * is exactly what gets imported.
 */
export async function extractTabular(
  buffer: Buffer,
  options: {
    sheetName?: string;
    savedMapping?: Record<string, ImportConcept>;
    overrides?: Record<number, ImportConcept>;
    /** Fields typed on the review screen, e.g. a PO number the file omits. */
    fieldOverrides?: Record<string, string | number | null>;
    /** The uploaded file's name: the order is named after it when the file names nothing. */
    fileName?: string;
  } = {},
): Promise<TabularExtractionResult> {
  const wb = new ExcelJS.Workbook();
  // A CSV is one unnamed sheet with no formatting, which the rest of this file
  // handles without knowing the difference — the column scoring, the LONG/WIDE
  // detection and the size-grid recovery all work on cell values. Reading it
  // here rather than converting it upstream means CSV support costs one branch
  // instead of a second pipeline.
  if (detectFileKind(buffer) === 'csv') {
    // One reader for every CSV, which also decides the delimiter.
    const csv = await readCsvWorkbook(buffer);
    for (const ws of csv.worksheets) wb.addWorksheet(ws.name).addRows(ws.getSheetValues().slice(1).map((r) => (Array.isArray(r) ? r.slice(1) : [])));
  } else {
    // Same clear message as everywhere else a workbook is opened.
    await loadWorkbook(wb, buffer);
  }

  const issues: ImportIssue[] = [];

  // Read every sheet as a table, keep the ones that parse, rank them.
  const tables: SheetTable[] = [];
  for (const sheet of wb.worksheets) {
    const table = readSheetTable(sheet);
    if (table) tables.push(table);
  }
  tables.sort((a, b) => b.score - a.score);

  // A factory laying sheet reads as a table too — panels as colours, lays as
  // sizes — and imported here it became an order of 84 "pieces" called front,
  // back and sl. It has a screen of its own. Its table is dropped, not merely
  // warned about: left in, it still came through as 205 "pieces" of White in
  // sizes named after marker ratios, one Confirm away from being an order.
  for (const sheet of wb.worksheets) {
    let laying = false;
    try { laying = readAgeLayingSheet(sheet) != null; } catch { /* not one */ }
    if (!laying) continue;
    issues.push({
      level: 'WARNING', field: 'documentKind', sheet: sheet.name, cell: null,
      message: `"${sheet.name}" is a laying & marking sheet (lays, layers and panels), not a purchase order. `
        + "Import it from the order's Laying & Marker screen; importing it here would create an order whose colours are panel names.",
    });
    const at = tables.findIndex((t) => t.sheetName === sheet.name);
    if (at !== -1) tables.splice(at, 1);
    break;
  }

  // A proforma invoice is the factory's own quotation, not the customer's
  // order. Its grid sheet may well hold the right quantities — it is read —
  // but the document is named for what it is, so nobody files it as a PO.
  const layingSheets = new Set(issues.filter((i) => i.field === 'documentKind').map((i) => i.sheet));
  for (const sheet of wb.worksheets) {
    if (layingSheets.has(sheet.name) || !looksLikeProforma(sheet)) continue;
    issues.push({
      level: 'WARNING', field: 'documentKind', sheet: sheet.name, cell: null,
      message: `"${sheet.name}" is a proforma invoice, not a purchase order. `
        + "If the workbook also carries the order's size grid it has been read below; check it against the customer's PO before confirming, or import it on the order's Proforma Invoice step instead.",
    });
    break;
  }

  const sheets: ImportSheetInfo[] = wb.worksheets.map((w) => {
    const t = tables.find((x) => x.sheetName === w.name);
    return {
      name: w.name,
      rows: w.rowCount,
      cols: w.columnCount,
      recognisedAs: t ? `Table with ${t.rows.length} rows` : null,
      confidence: t ? Math.min(1, t.score / 10) : 0,
    };
  });

  const chosen = options.sheetName
    ? tables.find((t) => t.sheetName === options.sheetName) ?? null
    : tables[0] ?? null;

  if (!chosen) {
    issues.push({
      level: 'WARNING', field: null, sheet: null, cell: null,
      message:
        'No table could be found in this file. The importer looks for a header row followed by data — ' +
        'check that the sheet has column headings such as Colour, Size and Quantity. ' +
        'You can still import and enter the quantities on the order.',
    });
    return emptyResult(sheets, issues, {
      sheetName: '', headerRowIndex: 0, columns: [], layout: 'UNKNOWN', sizeColumns: [],
      readiness: assessMapping([]), candidateSheets: [], checklist: buildChecklist([]), rowsDetected: 0,
    });
  }

  // Work out what each column is, then apply the coordinator's corrections.
  const columns = analyseColumns(chosen.headers, chosen.rows, options.savedMapping ?? {});
  if (options.overrides) {
    for (const [indexRaw, concept] of Object.entries(options.overrides)) {
      const column = columns.find((c) => c.index === Number(indexRaw));
      if (!column) continue;
      column.concept = concept;
      column.confidence = 1;
      column.needsConfirmation = false;
      column.source = 'MANUAL';
    }
  }

  const sizeColumns = detectSizeColumns(chosen.headers, chosen.rows);
  const hasSizeColumn = columns.some((c) => c.concept === ImportConcept.SIZE);
  let layout: TabularAnalysis['layout'] =
    hasSizeColumn ? 'LONG' : sizeColumns.length >= 2 ? 'WIDE' : 'UNKNOWN';

  const ctx: BuildContext = { table: chosen, analyses: columns, issues };
  let matrix =
    layout === 'LONG' ? buildLongMatrix(ctx)
    : layout === 'WIDE' ? buildWideMatrix(ctx, sizeColumns)
    : null;
  // No Size column and no size grid: the size may be inside the colour text.
  let sizesFromColour = false;
  if (!matrix && layout !== 'LONG') {
    matrix = buildLongMatrix(ctx, { sizeFromColour: true });
    if (matrix) { layout = 'LONG'; sizesFromColour = true; }
  }
  // Sizes down the side and colours across: the grid turned on its side.
  if (!matrix) {
    matrix = buildTransposedMatrix(chosen.headers, chosen.rows);
    if (matrix) {
      layout = 'WIDE';
      issues.push({
        level: 'INFO', field: null, sheet: chosen.sheetName, cell: null,
        message: `Read as a size grid turned on its side: one row per size (${matrix.sizes.join(', ')}) and one column per colour.`,
      });
    }
  }

  if (layout === 'WIDE' && !sizesFromColour) {
    issues.push({
      level: 'INFO', field: null, sheet: chosen.sheetName, cell: null,
      message:
        `Read as a size grid: ${sizeColumns.length} size columns ` +
        `(${sizeColumns.map((s) => s.name).join(', ')}) with one row per colour.`,
    });
  }

  if (!matrix) {
    issues.push({
      level: 'WARNING', field: null, sheet: chosen.sheetName, cell: null,
      message:
        layout === 'UNKNOWN'
          ? 'Colour, size and quantity columns could not all be identified. Map them below, '
            + 'or import now and enter the quantities on the order.'
          : 'The columns were identified but no rows had a colour, a size and a quantity together, '
            + 'so no quantities were read.',
    });
  }

  // Scalars: the header block above the table, then any column mapped to a
  // scalar concept (its first value), then whatever the coordinator typed.
  const sheet = wb.getWorksheet(chosen.sheetName)!;
  const fields: Record<string, string | number | Date | null> = {
    ...readHeaderBlock(sheet, chosen.headerRowIndex, issues),
  };

  for (const column of columns) {
    const meta = CONCEPT_META[column.concept];
    if (!meta.field || fields[meta.field] != null) continue;
    const firstValue = chosen.rows.map((r) => r[column.index]).find((v) => v != null && String(v).trim() !== '');
    if (firstValue == null) continue;

    fields[meta.field] =
      meta.type === 'number' ? toNumber(firstValue)
      : meta.type === 'date' ? toDate(firstValue)
      : String(cellText(firstValue)).trim();
  }

  // Read exactly as the commit reads them, so the preview cannot differ from
  // what is written — and a value that cannot be read is refused by name here
  // rather than turning into an Invalid Date or NaN further on.
  for (const [field, value] of Object.entries(options.fieldOverrides ?? {})) {
    fields[field] = parseFieldOverride(field, value);
  }

  // A buyer's template often names nothing — no PO cell, no description —
  // and "Spring buy 2027" is in the file's name. Better than an order with no
  // name at all; the review screen and Order Details can rename it.
  if (!fields.orderName && !fields.poNumber && options.fileName) {
    const stem = options.fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_]+/g, ' ').trim();
    if (stem) {
      fields.orderName = stem;
      issues.push({
        level: 'INFO', field: 'orderName', sheet: chosen.sheetName, cell: null,
        message: `The file names no order, so it is called "${stem}" after the file. Rename it on the review screen or on Order Details.`,
      });
    }
  }

  // A PO number the file does not carry is a question, not a failure: the
  // review screen can supply it, and the commit will refuse without it anyway.
  if (!fields.poNumber) {
    issues.push({
      level: 'WARNING', field: 'poNumber', sheet: chosen.sheetName, cell: null,
      message: 'No PO number was found in the file. The order will be created under a placeholder number — rename it on Order Details once the customer\'s number is known.',
    });
  }
  if (!fields.clientName) {
    issues.push({
      level: 'WARNING', field: 'clientName', sheet: chosen.sheetName, cell: null,
      message: 'No customer was found in the file. The order will be filed under "Unknown client" — set the customer on Order Details.',
    });
  }

  const readiness = assessMapping(columns);
  for (const missing of readiness.missing) {
    // WIDE files legitimately have no size *column* — the sizes are headers —
    // and a file whose sizes sit inside the colour text has already been read.
    if (missing === ImportConcept.SIZE && (layout === 'WIDE' || sizesFromColour)) continue;
    issues.push({
      level: 'WARNING', field: missing, sheet: chosen.sheetName, cell: null,
      message: `No column was identified as ${CONCEPT_META[missing].label}. `
        + `Map it below, or import now and fill it in on the order.`,
    });
  }

  // Line-shaped rows, for a document that is a list rather than a grid — a
  // proforma invoice above all. Built from the same columns the matrices use,
  // so a file that is both a grid and a list yields both.
  const lineIndex: Partial<Record<ImportConcept, number>> = {};
  for (const c of columns) {
    if (c.concept !== ImportConcept.IGNORE && lineIndex[c.concept] == null) {
      lineIndex[c.concept] = c.index;
    }
  }
  const lineItems = buildLineItems(chosen.rows, lineIndex);

  return {
    profileKey: 'generic-tabular',
    confidence: Math.min(1, chosen.score / 10),
    lineItems,
    sheets,
    mappings: columns.map((c) => ({
      field: c.concept,
      label: CONCEPT_META[c.concept].label,
      sheet: chosen.sheetName,
      anchor: c.header,
      offset: [0, 0] as [number, number],
      // A table column's provenance is its column letter and the row its
      // header sat on — "column D, header on row 5" is what somebody needs to
      // find it in the file. `headerRowIndex` is already the sheet's own
      // 1-based row number, so it is shown as it is.
      cell: `${columnLetter(c.index + 1)} (header row ${chosen.headerRowIndex})`,
      sampleValue: c.samples[0] ?? null,
      required: MATRIX_REQUIRED.has(c.concept),
      resolved: !c.needsConfirmation,
      // The scorer's own confidence, banded. Anything the scorer wanted
      // confirmed stays below HIGH so the review screen asks about it.
      confidence:
        c.needsConfirmation ? (c.confidence >= 0.5 ? 'MEDIUM' : 'LOW')
        : c.confidence >= 0.8 ? 'HIGH'
        : 'MEDIUM',
      interpretation:
        `Matched the column headed “${c.header}” on ${chosen.sheetName}` +
        (c.needsConfirmation ? ' — please confirm' : ''),
      alternative: null,
    })),
    fields,
    matrices: matrix ? [matrix] : [],
    bom: [],
    lays: [],
    externalColors: [],
    costing: {},
    issues,
    analysis: {
      sheetName: chosen.sheetName,
      headerRowIndex: chosen.headerRowIndex,
      columns,
      layout,
      sizeColumns: sizeColumns.map((s) => s.name),
      readiness,
      candidateSheets: tables.map((t) => ({
        name: t.sheetName,
        score: Math.round(t.score * 10) / 10,
        rows: t.rows.length,
        headerRowIndex: t.headerRowIndex,
      })),
      checklist: buildChecklist(columns),
      rowsDetected: chosen.rows.length,
    },
  };
}

const MATRIX_REQUIRED = new Set<ImportConcept>([
  ImportConcept.COLOR, ImportConcept.SIZE, ImportConcept.QUANTITY,
]);

/** The §5 "Excel Analysis" checklist — what was found, and in which column. */
function buildChecklist(columns: readonly ColumnAnalysis[]): TabularAnalysis['checklist'] {
  return ANALYSIS_CHECKLIST.map((concept) => {
    const hit = columns.find((c) => c.concept === concept);
    // Style and Article are the same idea under two names.
    const alias =
      concept === ImportConcept.STYLE
        ? columns.find((c) => c.concept === ImportConcept.ARTICLE)
        : undefined;
    const found = hit ?? alias;
    return {
      concept,
      label: CONCEPT_META[concept].label,
      detected: !!found,
      columnHeader: found?.header ?? null,
    };
  });
}

function emptyResult(
  sheets: ImportSheetInfo[],
  issues: ImportIssue[],
  analysis: TabularAnalysis,
): TabularExtractionResult {
  return {
    profileKey: 'generic-tabular',
    confidence: 0,
    lineItems: [],
    sheets,
    mappings: [],
    fields: {},
    matrices: [],
    bom: [],
    lays: [],
    externalColors: [],
    costing: {},
    issues,
    analysis,
  };
}

/**
 * A grid turned on its side: sizes down the first column, one column per
 * colour, numbers in the cells. Rare, but a real customer wrote one, and read
 * the usual way it was one colour called "As ordered" with a size of "120".
 *
 * Taken only when it is unmistakable: at least two rows whose first cell is a
 * size, at least two further columns headed by something that is not a size
 * and holding numbers under those rows. A "Total" row is left out.
 */
export function buildTransposedMatrix(headers: readonly string[], rows: readonly unknown[][]): ExtractedMatrix | null {
  const sizeRows = rows
    .map((r, i) => ({ r, i, label: String(cellText(r[0])).trim() }))
    .filter(({ label }) => label && looksLikeSize(label) && !isTotalsLabel(label));
  if (sizeRows.length < 2) return null;
  const colourCols = headers
    .map((h, i) => ({ h: (h ?? '').trim(), i }))
    .filter(({ h, i }) => i > 0 && h && !looksLikeSize(h) && toNumber(h) == null && !isTotalsLabel(h))
    .filter(({ i }) => sizeRows.filter(({ r }) => toNumber(r[i]) != null).length >= Math.ceil(sizeRows.length * 0.8));
  if (colourCols.length < 2) return null;
  const sizes = sizeRows.map(({ label }) => label);
  const out = colourCols.map(({ h, i }) => {
    const cells: Record<string, number> = {};
    for (const { r, label } of sizeRows) { const q = toNumber(r[i]); if (q != null && q > 0) cells[label] = (cells[label] ?? 0) + q; }
    return { color: h, cells, total: Object.values(cells).reduce((a, b) => a + b, 0) };
  }).filter((row) => row.total > 0);
  if (out.length === 0) return null;
  return { ledger: 'ORDER', sizes, rows: out, sheetTotal: null, computedTotal: out.reduce((a, r) => a + r.total, 0) };
}
