/**
 * Reading an order out of a PDF.
 *
 * Customers send purchase orders as PDFs at least as often as spreadsheets, and
 * until now those could only be filed as an attachment for somebody to retype.
 *
 * The strategy is to make a PDF look like a sheet, and then hand it to the
 * machinery that already reads sheets. A PDF has no rows and no columns — it
 * has glyphs at coordinates — so this module recovers the grid: text items are
 * grouped into lines by their y position, then into columns by their x
 * position, producing a rectangular table. From there the synonym engine in
 * `@opsflow/shared` decides what each column means, exactly as it does for an
 * unfamiliar workbook, and the result is the same `ExtractionResult` the two
 * Excel extractors produce.
 *
 * That shared return type is the point of the whole design. Preview,
 * validation, the correction screen and the transactional commit are all
 * unchanged and untouched — a PDF is a new way in, not a second pipeline.
 *
 * What this cannot do is read a scan. A PDF of a photographed page contains no
 * text layer, and no amount of geometry will recover one; that case is detected
 * and reported as an issue rather than returned as an empty order, because
 * silently extracting nothing is indistinguishable from an empty document.
 */

import {
  ImportConcept, analyseColumns, assessMapping, normaliseHeader,
  type ColumnAnalysis,
} from '@opsflow/shared';
import type { ImportIssue, ImportSheetInfo } from '@opsflow/shared';
import type { ExtractionResult } from './extractor.js';
import { detectSizeColumns } from './tabular-extractor.js';

/** One positioned run of text, as pdf.js reports it. */
interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
}

/**
 * Two glyphs belong to the same visual line when their baselines are within
 * this many points. Chosen from typography rather than taste: body text is
 * commonly 9–12pt on 11–14pt leading, so 3pt is comfortably inside one line and
 * comfortably outside the gap to the next. Subscripts and slightly rotated
 * scans are the known casualties, and both are rare in a purchase order.
 */
const LINE_TOLERANCE_PT = 3;

/**
 * A number as a document might write it.
 *
 * European decimals ("0,00"), thousands separators, and stray currency or
 * whitespace all appear in real purchase orders. A comma is a decimal point
 * only when it is not acting as a thousands separator, which is decided by
 * what follows it rather than by locale guesswork.
 */
export function toNum(v: string | undefined): number | null {
  if (v == null) return null;
  let t = v.replace(/[\s\u00a0]/g, '').replace(/[^0-9.,-]/g, '');
  if (t === '' || t === '-') return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  if (lastComma > lastDot) {
    t = t.replace(/\./g, '').replace(',', '.');       // 1.234,56
  } else {
    t = t.replace(/,/g, '');                          // 1,234.56
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A gap wider than this starts a new column. Narrower than a tab stop, wider
 * than the space between words at any normal size — the number that separates
 * "two cells" from "two words".
 */
const COLUMN_GAP_PT = 12;

export interface PdfExtractionOptions {
  /** Which concepts this flow is willing to recognise. */
  allowedConcepts?: readonly ImportConcept[];
  /** Injected in tests so the suite never loads a PDF engine. */
  reader?: (buffer: Buffer) => Promise<PdfPage[]>;
}

export interface PdfPage {
  pageNumber: number;
  items: TextItem[];
}

/** Read the text layer, page by page, with positions. */
async function readPdf(buffer: Buffer): Promise<PdfPage[]> {
  // Imported lazily and by its legacy build: the default entry point expects a
  // browser, and the server has no DOM to give it.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // A purchase order needs none of these, and each is a way in for a hostile
    // file rather than a feature.
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;

  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items: TextItem[] = [];
    for (const raw of content.items) {
      const it = raw as { str?: string; transform?: number[]; width?: number };
      const text = (it.str ?? '').trim();
      if (!text) continue;
      // transform is [a,b,c,d,e,f]; e and f are the x and y of the baseline.
      const [, , , , x, y] = it.transform ?? [0, 0, 0, 0, 0, 0];
      items.push({ text, x: x ?? 0, y: y ?? 0, width: it.width ?? 0 });
    }
    pages.push({ pageNumber: n, items });
  }
  await doc.destroy();
  return pages;
}

/**
 * Recover rows from positioned glyphs.
 *
 * Sorted by descending y because PDF coordinates start at the bottom of the
 * page, so the largest y is the top line — the reverse of how a page reads.
 */
export function groupIntoRows(items: readonly TextItem[]): TextItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.y - item.y) <= LINE_TOLERANCE_PT) row.push(item);
    else rows.push([item]);
  }
  for (const r of rows) r.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * A cell, with the horizontal span it occupied on the page.
 *
 * The span is what makes column alignment possible; an index is not enough,
 * because two rows of the same table can produce different numbers of cells.
 */
export interface PositionedCell {
  text: string;
  x: number;
  end: number;
}

/** Split one visual line into cells, keeping where each one sat. */
export function rowToPositionedCells(row: readonly TextItem[]): PositionedCell[] {
  const cells: PositionedCell[] = [];
  let text = '';
  let start = 0;
  let prevEnd: number | null = null;

  for (const item of row) {
    if (prevEnd != null && item.x - prevEnd > COLUMN_GAP_PT) {
      if (text.trim()) cells.push({ text: text.trim(), x: start, end: prevEnd });
      text = '';
    }
    if (!text) start = item.x;
    text = text ? `${text} ${item.text}` : item.text;
    prevEnd = item.x + item.width;
  }
  if (text.trim() && prevEnd != null) cells.push({ text: text.trim(), x: start, end: prevEnd });
  return cells;
}

/**
 * A band of consecutive lines that behave like one table.
 *
 * Building a single column model for a whole page does not work, and the reason
 * is worth stating: a letterhead and an "Order number / Date / Sales order"
 * line contribute their own x positions, those positions interleave with the
 * grid's, and a run of seven adjacent size columns becomes seven columns with
 * gaps between them. Adjacency is exactly what identifies a size grid, so the
 * grid stops being findable.
 *
 * So the table is located first. A band is a run of consecutive lines with a
 * similar number of cells; only the lines inside it define its columns, and
 * everything outside is read separately as prose.
 */
export interface TableBand {
  /** Index of the first line of the band, in the original line order. */
  start: number;
  /** The band's lines, aligned to a shared column model. */
  rows: string[][];
}

/** Lines with fewer cells than this are prose, not table rows. */
const MIN_TABLE_CELLS = 3;

export function findTableBands(lines: readonly PositionedCell[][]): TableBand[] {
  const bands: TableBand[] = [];
  let current: PositionedCell[][] = [];
  let start = 0;

  const flush = () => {
    if (current.length >= 2) {
      bands.push({ start, rows: alignIntoColumns(current) });
    }
    current = [];
  };

  for (const [i, line] of lines.entries()) {
    if (line.length < MIN_TABLE_CELLS) { flush(); continue; }

    // A line joins the band only if its width is comparable. "Season: 26/27
    // Brand: MEYBA" has four cells and sits directly above a ten-column size
    // grid; letting it in adds its x positions to the column model and splits
    // the grid's adjacent run, which is the one property that identifies a size
    // grid at all.
    const widest = Math.max(...current.map((c) => c.length), 0);
    const comparable = current.length === 0
      || Math.min(line.length, widest) / Math.max(line.length, widest) >= 0.6;

    if (!comparable) flush();
    if (current.length === 0) start = i;
    current.push(line);
  }
  flush();
  return bands;
}

/**
 * Place cells into columns shared by the lines given.
 *
 * Columns are the x positions where cells actually start, clustered so that
 * near-identical starts are one column; a cell belongs to the column whose
 * start it is nearest. Rows come back as fixed-width arrays with blanks where a
 * line had nothing — the shape a spreadsheet reader expects, which is why
 * everything downstream needs no knowledge of PDFs.
 */
export function alignIntoColumns(rows: readonly PositionedCell[][]): string[][] {
  const starts: number[] = [];
  for (const row of rows) {
    for (const c of row) {
      if (!starts.some((s) => Math.abs(s - c.x) <= COLUMN_GAP_PT / 2)) starts.push(c.x);
    }
  }
  starts.sort((a, b) => a - b);
  if (starts.length === 0) return rows.map(() => []);

  return rows.map((row) => {
    const out = new Array<string>(starts.length).fill('');
    for (const cell of row) {
      let best = 0;
      let bestDist = Infinity;
      for (const [i, st] of starts.entries()) {
        const d = Math.abs(st - cell.x);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      out[best] = out[best] ? `${out[best]} ${cell.text}` : cell.text;
    }
    return out.map((c) => c.trim());
  });
}

/**
 * Split one visual line into cells wherever the horizontal gap is wide enough
 * to be a column boundary rather than a word space.
 */
export function rowToCells(row: readonly TextItem[]): string[] {
  const cells: string[] = [];
  let current = '';
  let prevEnd: number | null = null;

  for (const item of row) {
    if (prevEnd != null && item.x - prevEnd > COLUMN_GAP_PT) {
      cells.push(current.trim());
      current = '';
    }
    current = current ? `${current} ${item.text}` : item.text;
    prevEnd = item.x + item.width;
  }
  if (current.trim()) cells.push(current.trim());
  return cells;
}

/**
 * The header is the first row whose cells the synonym engine recognises more of
 * than any other. Taking the first multi-cell row instead would pick up a
 * letterhead; scoring every candidate costs nothing on a document this size and
 * survives a page of address blocks above the table.
 */
export function findHeaderRow(
  rows: readonly string[][],
  allowed?: readonly ImportConcept[],
): { index: number; analyses: ColumnAnalysis[] } | null {
  let best: { index: number; analyses: ColumnAnalysis[]; score: number } | null = null;

  for (const [index, row] of rows.entries()) {
    if (row.length < 2) continue;
    // The sample rows the scorer uses to sanity-check a header against its data.
    const sample = rows.slice(index + 1, index + 6);
    const analyses = analyseColumns(
      row.map(normaliseHeader), sample, {},
      allowed ? new Set(allowed) : undefined,
    );
    const score = analyses.filter((a) => a.concept != null).length;
    if (score >= 2 && (!best || score > best.score)) best = { index, analyses, score };
  }
  return best ? { index: best.index, analyses: best.analyses } : null;
}

/**
 * Extract an order from a PDF.
 *
 * Returns the same shape the Excel extractors return, so everything downstream
 * — preview, correction, commit — is reached without changing any of it.
 */
export async function extractFromPdf(
  buffer: Buffer,
  options: PdfExtractionOptions = {},
): Promise<ExtractionResult> {
  const issues: ImportIssue[] = [];
  const pages = await (options.reader ?? readPdf)(buffer);

  const totalItems = pages.reduce((a, p) => a + p.items.length, 0);

  // ── The OCR seam ────────────────────────────────────────────────────────
  //
  // A page with no text layer is a raster — a scan or a photograph. Recovering
  // its words needs OCR, which is not installed: see the note in the README for
  // the measured cost and why it is a deployment decision rather than a code
  // one. When it is added, it belongs exactly here, producing `TextItem`s with
  // positions so that everything below — the line grouping, the column
  // splitting, the synonym scoring, the review screen — is reached unchanged.
  //
  // Deliberately not stubbed with a fake extractor. A seam that silently
  // returns nothing is indistinguishable from OCR that ran and found nothing,
  // and the difference is the whole point of the message below.
  if (totalItems === 0) {
    // Almost always a scan. Said plainly, because "no orders found" would send
    // somebody looking for a problem in the wrong place.
    issues.push({
      level: 'ERROR', field: null, sheet: null, cell: null,
      message:
        'This PDF has no text layer — it is a scan or a photograph rather than a ' +
        'generated document, so there are no words in it to read. Reading it needs ' +
        'OCR, which is not installed yet. For now: ask the customer for the original ' +
        'file (a PDF exported from Excel or Word carries its text), or enter the ' +
        'order by hand. Nothing was imported.',
    });
    return emptyResult(issues, pages);
  }

  // Every line of every page, then one column model for the lot, so a row with
  // an extra leading cell still lines up with the header above it.
  const positioned: PositionedCell[][] = [];
  for (const page of pages) {
    for (const line of groupIntoRows(page.items)) {
      const cells = rowToPositionedCells(line);
      if (cells.length > 0) positioned.push(cells);
    }
  }
  // Locate the table(s), then pick the one that reads best. Lines outside a
  // band are prose and are read separately for their label-and-value pairs.
  const bands = findTableBands(positioned);
  let chosen: { band: TableBand; header: { index: number; analyses: ColumnAnalysis[] }; score: number } | null = null;
  for (const band of bands) {
    const h = findHeaderRow(band.rows, options.allowedConcepts);
    if (!h) continue;
    const sample = band.rows.slice(h.index + 1);
    const score = detectSizeColumns(band.rows[h.index] ?? [], sample).length * 3
      + h.analyses.filter((a) => a.concept != null).length;
    if (!chosen || score > chosen.score) chosen = { band, header: h, score };
  }

  const rows = chosen ? chosen.band.rows : [];
  // The lines the table does not own, as flat text, for the fields below.
  const proseRows = positioned
    .filter((_, i) => !chosen || i < chosen.band.start || i >= chosen.band.start + chosen.band.rows.length)
    .map((line) => line.map((c) => c.text));

  const header = chosen?.header ?? null;
  if (!header) {
    issues.push({
      level: 'ERROR', field: null, sheet: null, cell: null,
      message:
        'No table could be recognised in this PDF. The text was read, but no row ' +
        'looked like column headings. Check the document has a table, or enter ' +
        'the order by hand.',
    });
    return emptyResult(issues, pages);
  }

  // ── The rows under the header ───────────────────────────────────────────
  //
  // Recognising the columns is only half of it; without this the extraction
  // reported what it *could* read and returned none of it.
  const conceptFor = new Map<number, ImportConcept>();
  header.analyses.forEach((a, i) => { if (a.concept) conceptFor.set(i, a.concept); });

  const colOf = (c: ImportConcept) => [...conceptFor].find(([, v]) => v === c)?.[0];
  const iColor = colOf(ImportConcept.COLOR);
  const iSize = colOf(ImportConcept.SIZE);
  const iQty = colOf(ImportConcept.QUANTITY);

  const dataRows = rows.slice(header.index + 1);

  const dataAfterHeader = dataRows.filter((r) => r.some((c) => c.trim() !== ''));
  const matrices: ExtractionResult['matrices'] = [];

  // ── WIDE: the sizes are the column headings ─────────────────────────────
  //
  // The classic size grid, and the shape most customer purchase orders arrive
  // in. `detectSizeColumns` is the Excel reader's, reused rather than rewritten
  // — a run of adjacent columns whose headings are size tokens and whose cells
  // are numbers is a size grid whatever the document was.
  const sizeCols = detectSizeColumns(rows[header.index] ?? [], dataAfterHeader);
  if (sizeCols.length >= 2) {
    const sizeIdx = new Set(sizeCols.map((c) => c.index));
    const matrixRows: Array<{ color: string; cells: Record<string, number>; total: number }> = [];

    for (const row of dataAfterHeader) {
      const cells: Record<string, number> = {};
      let total = 0;
      for (const sc of sizeCols) {
        const qty = toNum(row[sc.index]);
        if (qty == null || qty <= 0) continue;
        cells[sc.name] = (cells[sc.name] ?? 0) + qty;
        total += qty;
      }
      if (total === 0) continue;

      // The colour is the leftmost cell that is not part of the grid and is not
      // a number — the grid's own row label, whether or not it has a heading.
      const label = row
        .map((c, i) => ({ c: c.trim(), i }))
        .filter(({ c, i }) => c !== '' && !sizeIdx.has(i) && i < (sizeCols[0]?.index ?? 0) && toNum(c) == null)
        .map(({ c }) => c)[0];
      if (!label) continue;
      // "Total" is the sheet's own sum, not a colour.
      if (/^(total|sum|grand total)$/i.test(label)) continue;

      matrixRows.push({ color: label, cells, total });
    }

    if (matrixRows.length > 0) {
      matrices.push({
        ledger: 'ORDER',
        sizes: sizeCols.map((c) => c.name),
        rows: matrixRows,
        sheetTotal: null,
        computedTotal: matrixRows.reduce((a, r) => a + r.total, 0),
      });
    }
  }

  // ── LONG: one row per colour, size and quantity ─────────────────────────
  if (matrices.length === 0 && iColor != null && iSize != null && iQty != null) {
    // A long table — one row per colour/size/quantity — folded into the same
    // matrix shape the workbook readers produce.
    const byColor = new Map<string, Record<string, number>>();
    const sizes: string[] = [];
    for (const row of dataAfterHeader) {
      const color = (row[iColor] ?? '').trim();
      const size = (row[iSize] ?? '').trim();
      const qty = toNum(row[iQty]);
      if (!color || !size || qty == null || qty <= 0) continue;
      if (!sizes.includes(size)) sizes.push(size);
      const cells = byColor.get(color) ?? {};
      cells[size] = (cells[size] ?? 0) + qty;
      byColor.set(color, cells);
    }
    if (byColor.size > 0) {
      const matrixRows = [...byColor].map(([color, cells]) => ({
        color, cells, total: Object.values(cells).reduce((a, b) => a + b, 0),
      }));
      matrices.push({
        ledger: 'ORDER', sizes, rows: matrixRows, sheetTotal: null,
        computedTotal: matrixRows.reduce((a, r) => a + r.total, 0),
      });
    }
  }

  // ── Loose "Label: value" pairs ──────────────────────────────────────────
  //
  // A purchase order states its number, buyer and delivery date above the
  // table rather than as columns, so the header rows are read the same way a
  // labelled cell is: match the left side against the synonym table, take the
  // right side as the value. Rows belonging to the table are skipped.
  const fields: ExtractionResult['fields'] = {};
  for (const row of proseRows) {
    if (row.length < 2) continue;
    // One line often carries several pairs — "Order number: 178  Date: 04-06-2026
    // Sales order: 817" — so they are read pairwise rather than as one label
    // followed by the rest of the line.
    for (let i = 0; i + 1 < row.length; i += 2) {
      readPair(row[i], row[i + 1]);
    }
    // And once more offset by one, for a line that begins with something other
    // than a label.
    for (let i = 1; i + 1 < row.length; i += 2) {
      readPair(row[i], row[i + 1]);
    }
  }

  function readPair(label: string | undefined, value: string | undefined): void {
    const v = (value ?? '').trim();
    if (!v || !label?.trim()) return;
    // A label reads as a label: it ends in a colon, or is short enough to be one.
    if (!/:\s*$/.test(label) && label.trim().split(/\s+/).length > 4) return;
    const [match] = analyseColumns([normaliseHeader(label)], [[v]], {},
      options.allowedConcepts ? new Set(options.allowedConcepts) : undefined);
    // IGNORE is a real answer from the scorer — "recognised, and not wanted" —
    // and must not be stored as though it were a field.
    if (match?.concept && match.concept !== ImportConcept.IGNORE && fields[match.concept] == null) {
      fields[match.concept] = v;
    }
  }
  // A single-valued column — one unit price repeated down the table — is a
  // document-level fact rather than a per-row one.
  for (const [col, concept] of conceptFor) {
    if (concept === ImportConcept.COLOR || concept === ImportConcept.SIZE
      || concept === ImportConcept.QUANTITY || concept === ImportConcept.IGNORE) continue;
    const values = new Set(dataRows.map((r) => (r[col] ?? '').trim()).filter(Boolean));
    if (values.size === 1 && fields[concept] == null) fields[concept] = [...values][0]!;
  }

  const isWide = matrices.length > 0 && sizeCols.length >= 2;
  const gridIdx = new Set(sizeCols.map((c) => c.index));

  const readiness = assessMapping(header.analyses);
  for (const concept of readiness.missing) {
    // A size grid legitimately has no colour, size or quantity *column* — the
    // sizes are the headings, the colour is the row label and the quantity is
    // the cell. Reporting them missing while the grid has already been read
    // tells the user to fix something that is not broken. The Excel reader
    // makes the same exemption for the same reason.
    if (isWide && (concept === ImportConcept.SIZE || concept === ImportConcept.COLOR
      || concept === ImportConcept.QUANTITY)) continue;
    issues.push({
      level: 'ERROR', field: concept, sheet: 'PDF', cell: null,
      message: `No column in this PDF looks like ${concept.toLowerCase().replace(/_/g, ' ')}. Assign one on the review screen.`,
    });
  }
  for (const col of readiness.unconfirmed) {
    // A grid heading is a size, not a mis-read concept column. "XXL" scoring as
    // a colour is the scorer doing its job on a word it was handed out of
    // context, and surfacing it would be noise.
    if (isWide && gridIdx.has(header.analyses.indexOf(col))) continue;
    issues.push({
      level: 'WARNING', field: col.concept ?? null, sheet: 'PDF', cell: col.header,
      message: `"${col.header}" was read as ${col.concept ?? 'nothing recognisable'}. Confirm it before importing.`,
    });
  }

  const mappings: ExtractionResult['mappings'] = header.analyses.map((a, i) => (
    isWide && gridIdx.has(i)
      ? {
          field: `size:${sizeCols.find((c) => c.index === i)?.name ?? ''}`,
          label: a.header, sheet: 'PDF', anchor: null, offset: null,
          cell: `column ${i + 1}`, sampleValue: null, required: false,
          resolved: true, confidence: 'MEDIUM' as const,
        }
      : {
    field: a.concept ? String(a.concept) : `column${i + 1}`,
    label: a.header,
    sheet: 'PDF',
    anchor: null,
    offset: null,
    cell: `column ${i + 1}`,
    sampleValue: null,
    required: false,
    resolved: a.concept != null,
    // A PDF's geometry is recovered rather than read, so even a confident
    // column match is one inference further from the source than a spreadsheet
    // cell. MEDIUM at best, so the review screen always asks.
    confidence: a.concept != null ? 'MEDIUM' : 'NONE',
      }));

  if (matrices.length === 0 && Object.keys(fields).length === 0) {
    issues.push({
      level: 'WARNING', field: null, sheet: 'PDF', cell: null,
      message:
        'A table was found but no rows could be read from it. Check the review screen — ' +
        'the columns may need assigning by hand.',
    });
  }

  return {
    ...emptyResult(issues, pages),
    profileKey: 'pdf',
    confidence: readiness.ready ? 0.7 : 0.3,
    mappings,
    fields,
    matrices,
    issues,
  };
}

function emptyResult(issues: ImportIssue[], pages: readonly PdfPage[]): ExtractionResult {
  const sheets: ImportSheetInfo[] = pages.map((p) => ({
    name: `Page ${p.pageNumber}`,
    rows: 0,
    cols: 0,
    recognisedAs: p.items.length > 0 ? 'text' : null,
    confidence: p.items.length > 0 ? 1 : 0,
  }));

  return {
    profileKey: null, confidence: 0, sheets, mappings: [], fields: {},
    matrices: [], bom: [], lays: [], externalColors: [], costing: {}, issues,
  };
}
