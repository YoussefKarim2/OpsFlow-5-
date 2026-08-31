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
  ImportConcept, analyseColumns, assessMapping, normaliseHeader,
  CONCEPT_META, ANALYSIS_CHECKLIST,
  type ColumnAnalysis,
} from '@opsflow/shared';
import type { ImportIssue, ImportSheetInfo } from '@opsflow/shared';
import type { ExtractionResult, ExtractedMatrix } from './extractor.js';
import { cellText, toNumber, toDate } from './extractor.js';
import { safeDate, toIsoDayOrNull } from '@opsflow/shared';

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

const MAX_SCAN_ROWS = 400;
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
const MIN_HEADER_COLUMNS = 3;

/**
 * Rows that could plausibly be the header.
 *
 * Spreadsheets from customers rarely start at A1 — there is a logo, a title
 * block, a blank row, then the table. Rather than taking the first plausible
 * row, every candidate is scored as a table and the best one wins, because
 * "first" and "best" are not the same row in a file with a title block.
 */
function findHeaderCandidates(sheet: ExcelJS.Worksheet): number[] {
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
    const numeric = cells.filter((x) => /^-?[\d,.\s]+$/.test(x.text)).length;
    if (numeric > cells.length / 2) continue;

    const next = sheet.getRow(r + 1);
    const populated = cells.filter((x) => {
      const v = rawValue(next.getCell(x.col));
      return v != null && String(cellText(v)).trim() !== '';
    }).length;

    if (populated >= Math.max(2, Math.floor(cells.length * 0.4))) candidates.push(r);
  }
  return candidates;
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

function readTableAt(sheet: ExcelJS.Worksheet, headerRowIndex: number): SheetTable | null {
  const headerRow = sheet.getRow(headerRowIndex);
  const headers: string[] = [];
  const columns: number[] = [];

  let lastPopulated = 0;
  for (let c = 1; c <= Math.min(sheet.columnCount || MAX_SCAN_COLS, MAX_SCAN_COLS); c++) {
    const text = String(cellText(rawValue(headerRow.getCell(c)))).trim();
    headers.push(text);
    columns.push(c);
    if (text) lastPopulated = c;
  }
  headers.length = lastPopulated;
  columns.length = lastPopulated;

  const rows: unknown[][] = [];
  let blankRun = 0;

  for (let r = headerRowIndex + 1; r <= Math.min(sheet.rowCount || MAX_SCAN_ROWS, MAX_SCAN_ROWS); r++) {
    const row = sheet.getRow(r);
    const values = columns.map((c) => rawValue(row.getCell(c)));
    const populated = values.filter((v) => v != null && String(cellText(v)).trim() !== '').length;

    if (populated === 0) {
      // A gap is normal in a hand-maintained sheet; ten in a row is the end.
      if (++blankRun >= 10) break;
      continue;
    }
    blankRun = 0;

    // A totals row is a summary of the data, not part of it. Importing it
    // doubles the order.
    const first = String(cellText(values[0])).trim().toLowerCase();
    if (/^(total|totals|grand total|sum|subtotal)\b/.test(first)) break;

    rows.push(values);
  }

  if (rows.length === 0) return null;

  return {
    sheetName: sheet.name,
    headerRowIndex,
    headers,
    rows,
    score: scoreTable(headers, rows),
  };
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
const SIZE_TOKEN = /^(?:\d?\s?[xy]{0,3}(?:xs|s|m|l|xl|xxl|xxxl)|[0-9]{1,3}(?:\/[0-9]{1,3})?|os|one size|free)$/i;

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

function looksLikeSize(header: string): boolean {
  const h = normaliseHeader(header).replace(/\s+/g, '');
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

/** LONG layout: one row per colour × size × quantity. */
function buildLongMatrix(ctx: BuildContext): ExtractedMatrix | null {
  const colorCol = columnFor(ctx.analyses, ImportConcept.COLOR);
  const sizeCol = columnFor(ctx.analyses, ImportConcept.SIZE);
  const qtyCol = columnFor(ctx.analyses, ImportConcept.QUANTITY);
  if (colorCol == null || sizeCol == null || qtyCol == null) return null;

  const byColor = new Map<string, Record<string, number>>();
  const sizeOrder: string[] = [];
  let skipped = 0;

  for (const row of ctx.table.rows) {
    const color = String(cellText(row[colorCol])).trim();
    const size = String(cellText(row[sizeCol])).trim();
    const qty = toNumber(row[qtyCol]);

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

  if (skipped > 0) {
    ctx.issues.push({
      level: 'WARNING', field: null, sheet: ctx.table.sheetName, cell: null,
      message:
        `${skipped} row${skipped === 1 ? '' : 's'} were skipped because they had no colour, no size, ` +
        `or no quantity. ${ctx.table.rows.length - skipped} rows were read.`,
    });
  }

  const rows = [...byColor.entries()].map(([color, cells]) => ({
    color,
    cells,
    total: Object.values(cells).reduce((a, b) => a + b, 0),
  }));

  return {
    ledger: 'ORDER',
    sizes: sizeOrder,
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

    const cells: Record<string, number> = {};
    let total = 0;
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
  } = {},
): Promise<TabularExtractionResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const issues: ImportIssue[] = [];

  // Read every sheet as a table, keep the ones that parse, rank them.
  const tables: SheetTable[] = [];
  for (const sheet of wb.worksheets) {
    const table = readSheetTable(sheet);
    if (table) tables.push(table);
  }
  tables.sort((a, b) => b.score - a.score);

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
      level: 'ERROR', field: null, sheet: null, cell: null,
      message:
        'No table could be found in this file. The importer looks for a header row followed by data — ' +
        'check that the sheet has column headings such as Colour, Size and Quantity.',
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
  const layout: TabularAnalysis['layout'] =
    hasSizeColumn ? 'LONG' : sizeColumns.length >= 2 ? 'WIDE' : 'UNKNOWN';

  const ctx: BuildContext = { table: chosen, analyses: columns, issues };
  const matrix =
    layout === 'LONG' ? buildLongMatrix(ctx)
    : layout === 'WIDE' ? buildWideMatrix(ctx, sizeColumns)
    : null;

  if (layout === 'WIDE') {
    issues.push({
      level: 'INFO', field: null, sheet: chosen.sheetName, cell: null,
      message:
        `Read as a size grid: ${sizeColumns.length} size columns ` +
        `(${sizeColumns.map((s) => s.name).join(', ')}) with one row per colour.`,
    });
  }

  if (!matrix) {
    issues.push({
      level: 'ERROR', field: null, sheet: chosen.sheetName, cell: null,
      message:
        layout === 'UNKNOWN'
          ? 'Colour, size and quantity columns could not all be identified. Map them below and try again.'
          : 'The columns were identified but no rows had a colour, a size and a quantity together.',
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

  for (const [field, value] of Object.entries(options.fieldOverrides ?? {})) {
    if (value === null || value === '') { fields[field] = null; continue; }
    const spec = Object.values(CONCEPT_META).find((m) => m.field === field);
    fields[field] =
      spec?.type === 'number' ? Number(value)
      // `new Date(String(value))` here was the other half of the crash: an
      // override the coordinator typed as "13/09/2026" became an Invalid Date
      // that threw the moment the preview tried to render it.
      : spec?.type === 'date' ? safeDate(value)
      : String(value);
  }

  // A PO number the file does not carry is a question, not a failure: the
  // review screen can supply it, and the commit will refuse without it anyway.
  if (!fields.poNumber) {
    issues.push({
      level: 'WARNING', field: 'poNumber', sheet: chosen.sheetName, cell: null,
      message: 'No PO number was found in the file. Enter one on the review screen before importing.',
    });
  }
  if (!fields.clientName) {
    issues.push({
      level: 'WARNING', field: 'clientName', sheet: chosen.sheetName, cell: null,
      message: 'No customer was found in the file. Choose one on the review screen before importing.',
    });
  }

  const readiness = assessMapping(columns);
  for (const missing of readiness.missing) {
    // WIDE files legitimately have no size *column* — the sizes are headers.
    if (missing === ImportConcept.SIZE && layout === 'WIDE') continue;
    issues.push({
      level: 'ERROR', field: missing, sheet: chosen.sheetName, cell: null,
      message: `No column was identified as ${CONCEPT_META[missing].label}. Map it below before importing.`,
    });
  }

  return {
    profileKey: 'generic-tabular',
    confidence: Math.min(1, chosen.score / 10),
    sheets,
    mappings: columns.map((c) => ({
      field: c.concept,
      label: CONCEPT_META[c.concept].label,
      sheet: chosen.sheetName,
      anchor: c.header,
      offset: [0, 0] as [number, number],
      // A table column's provenance is its column letter and the row its
      // header sat on — "column D, header on row 5" is what somebody needs to
      // find it in the file.
      cell: `${columnLetter(c.index + 1)} (header row ${chosen.headerRowIndex + 1})`,
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
