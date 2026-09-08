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

  const rows: string[][] = [];
  for (const page of pages) {
    for (const line of groupIntoRows(page.items)) {
      const cells = rowToCells(line);
      if (cells.length > 0) rows.push(cells);
    }
  }

  const header = findHeaderRow(rows, options.allowedConcepts);
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

  const readiness = assessMapping(header.analyses);
  for (const concept of readiness.missing) {
    issues.push({
      level: 'ERROR', field: concept, sheet: 'PDF', cell: null,
      message: `No column in this PDF looks like ${concept.toLowerCase().replace(/_/g, ' ')}. Assign one on the review screen.`,
    });
  }
  for (const col of readiness.unconfirmed) {
    issues.push({
      level: 'WARNING', field: col.concept ?? null, sheet: 'PDF', cell: col.header,
      message: `"${col.header}" was read as ${col.concept ?? 'nothing recognisable'}. Confirm it before importing.`,
    });
  }

  const mappings: ExtractionResult['mappings'] = header.analyses.map((a, i) => ({
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

  return {
    ...emptyResult(issues, pages),
    profileKey: 'pdf',
    confidence: readiness.ready ? 0.7 : 0.3,
    mappings,
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
