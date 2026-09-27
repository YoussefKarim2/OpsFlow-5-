/**
 * Excel extraction.
 *
 * Reads an uploaded workbook against a profile and produces a structured,
 * validated draft order. Nothing is written to the database here — this stage
 * only reads, reports and previews. The commit is a separate, transactional
 * step, so a bad file can never leave a half-created order behind.
 */

import ExcelJS from 'exceljs';
import type { ImportProfile, FieldSpec, MatrixSpec } from './profiles.js';
import { detectProfile, PROFILES } from './profiles.js';
import type { ImportIssue, ImportSheetInfo, ImportFieldMapping } from '@opsflow/shared';
import {
  safeDate, toIsoDateOrNull, toIsoDayOrNull, isValidDate, parseSpreadsheetDate, ImportConcept, CONCEPT_META,
} from '@opsflow/shared';
import { openWorkbook } from './open-workbook.js';
import { ValidationError } from '../../errors.js';
import { assertValidPercentage } from '../rules.js';

export interface ExtractedMatrix {
  ledger: string;
  sizes: string[];
  rows: Array<{ color: string; cells: Record<string, number>; total: number }>;
  /** The sheet's own SUM row, used to cross-check our arithmetic. */
  sheetTotal: number | null;
  computedTotal: number;
}

export interface ExtractedBomLine {
  category: string | null;
  position: string | null;
  consumptionPerPiece: number | null;
  item: string | null;
  description: string | null;
  color: string | null;
  requiredQty: number | null;
  unit: string | null;
  issuedQty: number | null;
  issuedBy: string | null;
  issuedTo: string | null;
}

export interface ExtractedLay {
  fabric: string | null;
  color: string | null;
  panel: string | null;
  sizeRatio: string | null;
  layers: number | null;
  markerLengthM: number | null;
  totalLengthM: number | null;
  nestPcs: number | null;
}

/**
 * One priced row of a document, as written.
 *
 * The matrices describe an order as colour × size; plenty of documents — a
 * proforma invoice above all — are simply a list: a description, how many, and
 * what each costs. That shape had nowhere to go, so a proforma laid out as a
 * list imported with its header filled and no items at all.
 *
 * Deliberately generic, and deliberately not a proforma type: it is whatever
 * line-shaped rows the reader could see, and the targets decide what a line
 * means to them.
 */
export interface ExtractedLineItem {
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  /** Position among the data rows — 1 is the first, for pointing at a row. */
  rowNumber: number;
}

/**
 * Line-shaped rows out of a table, wherever the reader found one.
 *
 * Shared by the workbook and PDF readers so a proforma laid out as a list is
 * read identically whichever kind of file it arrived in. A row counts as a line
 * if it says *something* — a description or a quantity — because a document
 * that prices its rows separately and one that states a single price at the top
 * are both real, and refusing the ones with a blank cell would throw away most
 * of the invoice.
 */
export function buildLineItems(
  rows: readonly (readonly unknown[])[],
  index: Partial<Record<ImportConcept, number>>,
): ExtractedLineItem[] {
  const at = (row: readonly unknown[], concept: ImportConcept): unknown => {
    const i = index[concept];
    return i == null ? null : row[i];
  };
  const text = (v: unknown): string | null => {
    const t = String(cellText(v) ?? '').trim();
    return t === '' ? null : t;
  };

  const items: ExtractedLineItem[] = [];
  for (const row of rows) {
    const description = text(at(row, ImportConcept.DESCRIPTION))
      ?? text(at(row, ImportConcept.MATERIAL));
    const quantity = toNumber(at(row, ImportConcept.QUANTITY));
    const unitPrice = toNumber(at(row, ImportConcept.UNIT_PRICE))
      ?? toNumber(at(row, ImportConcept.ITEM_UNIT_PRICE));

    // Nothing at all on the row: a spacer or a trailing blank, not a line.
    if (description == null && quantity == null && unitPrice == null) continue;

    // A totals line restates the invoice rather than adding to it, and
    // invoicing it again would double the document.
    if (description != null && /^(total|sub\s*total|grand\s*total|sum)\b/i.test(description)) continue;

    items.push({
      description,
      quantity,
      unit: text(at(row, ImportConcept.UNIT)) ?? 'PCS',
      unitPrice,
      rowNumber: items.length + 1,
    });
  }
  return items;
}

export interface ExtractionResult {
  profileKey: string | null;
  confidence: number;
  sheets: ImportSheetInfo[];
  mappings: ImportFieldMapping[];
  fields: Record<string, string | number | Date | null>;
  matrices: ExtractedMatrix[];
  /** Line-shaped rows, for documents that are a list rather than a grid. */
  lineItems: ExtractedLineItem[];
  bom: ExtractedBomLine[];
  lays: ExtractedLay[];
  externalColors: Array<{ color: string; qty: number; rate: number | null; area: number | null }>;
  costing: Record<string, number | null>;
  issues: ImportIssue[];
}

// ── Cell helpers ────────────────────────────────────────────────────────────

/** Normalise a label for anchor matching: lowercase, strip punctuation and spacing. */
function norm(v: unknown): string {
  if (v == null) return '';
  return String(cellText(v)).toLowerCase().replace(/[:\s‏‎.،]+/g, ' ').replace(/[^a-z0-9؀-ۿ %/]/g, '').trim();
}

/**
 * ExcelJS cells can be rich text, formula results, hyperlinks or plain values.
 *
 * An object shape this does not recognise returns empty, never `[object
 * Object]`. That case is real: PO 13506's Stock sheet takes its whole size
 * header by shared formula from Main Order, and a workbook saved by something
 * other than Excel carries no cached results for those cells. Falling through
 * to `String(value)` there produced four size columns literally named
 * "[object Object]" — a column heading that is worse than a missing one,
 * because it looks like data.
 */
function cellText(value: unknown): string {
  if (value == null) return '';
  // An Invalid Date passes `instanceof Date` and throws on toISOString. This
  // one line is where "RangeError: Invalid time value" used to come from: a
  // single unreadable date cell, three sheets in, killed the whole import.
  if (value instanceof Date) return toIsoDateOrNull(value) ?? '';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('richText' in v && Array.isArray(v.richText)) {
      return (v.richText as Array<{ text: string }>).map((r) => r.text).join('');
    }
    if ('text' in v && typeof v.text === 'string') return v.text;
    // A formula cell with no cached result has nothing to read, and `result`
    // being present but null is exactly that case.
    if ('result' in v) return v.result == null ? '' : cellText(v.result);
    if ('formula' in v || 'sharedFormula' in v) return '';
    if ('hyperlink' in v && 'text' in v) return String(v.text);
    if ('error' in v) return '';
    return '';
  }
  return String(value);
}

function cellValue(cell: ExcelJS.Cell | undefined): unknown {
  if (!cell) return null;
  const v = cell.value;
  if (v == null) return null;
  if (typeof v === 'object' && 'result' in (v as object)) {
    return (v as { result: unknown }).result;
  }
  if (typeof v === 'object' && 'richText' in (v as object)) return cellText(v);
  return v;
}

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(cellText(value)).replace(/[,\s$]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every date in the import path goes through `safeDate` in @opsflow/shared.
 *
 * It returns a valid Date or null and never an Invalid Date, so nothing
 * downstream has to remember to check — which is what went wrong before.
 */
function toDate(value: unknown): Date | null {
  return safeDate(value);
}

/** True for the Excel error strings the source workbook is full of. */
function isExcelError(value: unknown): boolean {
  const s = String(cellText(value));
  return /^#(VALUE|DIV\/0|REF|NAME|N\/A|NULL|NUM)[!?]/.test(s);
}

interface Found { row: number; col: number; }

/** Locate a cell whose text matches `anchor`, scanning row-major. */
function findAnchor(sheet: ExcelJS.Worksheet, anchor: string, maxRow = 200, maxCol = 80): Found | null {
  const target = norm(anchor);
  if (!target) return null;
  for (let r = 1; r <= Math.min(sheet.rowCount || maxRow, maxRow); r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= Math.min(sheet.columnCount || maxCol, maxCol); c++) {
      const text = norm(cellValue(row.getCell(c)));
      if (!text) continue;
      // startsWith rather than equality: sheets write "Po No :" and "Item Type :".
      if (text === target || text.startsWith(target)) return { row: r, col: c };
    }
  }
  return null;
}

/**
 * Locate a table's header row: a cell reading exactly `anchor` on a row that
 * also carries a `companion` heading.
 *
 * `findAnchor`'s prefix match is right for a label with a colon after it and
 * wrong for a one-word column heading. The lay plan's header begins "fabric",
 * and the same sheet has a "Fabric 1 / Fabric 2 / Fabric Description" block
 * above it — the prefix match stopped there, read the rows beneath a caption
 * as lays, found none, and every AGE workbook imported with no lay plan at all.
 * Requiring the exact word, on a row that also has the table's other heading,
 * is what tells the table apart from a caption that happens to share a word.
 */
function findHeaderRow(
  sheet: ExcelJS.Worksheet, anchor: string, companion: string, maxRow = 200, maxCol = 80,
): Found | null {
  const target = norm(anchor);
  const also = norm(companion);
  if (!target) return null;
  const lastCol = Math.min(sheet.columnCount || maxCol, maxCol);
  for (let r = 1; r <= Math.min(sheet.rowCount || maxRow, maxRow); r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= lastCol; c++) {
      if (norm(cellValue(row.getCell(c))) !== target) continue;
      for (let k = c + 1; k <= lastCol; k++) {
        if (norm(cellValue(row.getCell(k))).startsWith(also)) return { row: r, col: c };
      }
    }
  }
  return null;
}

/**
 * Read the value at an anchor + offset. When the immediate cell is blank
 * (merged cells report only in their top-left), scan a little further right,
 * which is what a human reading the sheet does.
 *
 * Two guards on that scan, both put here because PO 13506 walked straight
 * through the absence of them.
 *
 * **A merged cell belongs to its own row.** On `Order Details_Coordinator`,
 * "Fit" sits at C10 with D10 empty, and F9:F12 is a merged cell holding the
 * label "Billing Adress". ExcelJS reports a merged value in every cell of the
 * range, so the rightward scan reached F10, found text, and imported the order
 * with a *fit* of "Billing Adress" — and a block pattern of the same. Nothing
 * complained, because a string is a string. A merged cell whose master is on
 * another row is somebody else's block, and is skipped.
 *
 * **A label is not a value.** Any candidate whose text matches another field's
 * anchor on the same sheet is a heading that happens to be to the right, not
 * this field's answer.
 */
/**
 * True when this cell only holds a value because it is part of a merged region
 * that begins on a different row — i.e. the value belongs to another block.
 */
function mergedFromAnotherRow(cell: ExcelJS.Cell, targetRow: number): boolean {
  const c = cell as unknown as { isMerged?: boolean; master?: { row?: unknown } };
  if (!c.isMerged || c.master?.row == null) return false;
  const masterRow = Number(c.master.row);
  return Number.isFinite(masterRow) && masterRow !== targetRow;
}

function readAnchored(
  sheet: ExcelJS.Worksheet,
  spec: FieldSpec,
  siblingAnchors: ReadonlySet<string> = new Set(),
): { value: unknown; cell: string | null; found: boolean } {
  const anchor = findAnchor(sheet, spec.anchor);
  if (!anchor) return { value: null, cell: null, found: false };

  const [dr, dc] = spec.offset;
  const targetRow = anchor.row + dr;

  for (let extra = 0; extra <= 4; extra++) {
    const c = anchor.col + dc + (dc === 0 ? 0 : extra);
    const cell = sheet.getRow(targetRow).getCell(c);

    // Merged from another row — a neighbouring block bleeding sideways.
    // ExcelJS types `Cell.row` as a string but hands back a number, so this
    // goes through Number() rather than trusting either.
    if (mergedFromAnotherRow(cell, targetRow)) {
      if (dc === 0) break;
      continue;
    }

    const raw = cellValue(cell);
    const text = String(cellText(raw)).trim();
    if (raw != null && text !== '' && !isExcelError(raw)) {
      if (siblingAnchors.has(norm(text))) {
        // Another field's heading. Keep looking, but never take it.
        if (dc === 0) break;
        continue;
      }
      return { value: raw, cell: `${colLetter(c)}${targetRow}`, found: true };
    }
    if (dc === 0) break;
  }
  return { value: null, cell: `${colLetter(anchor.col + dc)}${targetRow}`, found: true };
}

function colLetter(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); }
  return s;
}

// ── Matrix reader ───────────────────────────────────────────────────────────

/**
 * Read a colour × size matrix.
 *
 * Finds the header row by its "Color" cell, reads size labels rightward until
 * a blank, then reads rows downward until the "Totals" row. That last part
 * matters: the workbook keeps ~20 empty spare rows between the data and the
 * totals because a spreadsheet cannot grow, and a naive reader imports them as
 * empty colours.
 */
function extractMatrix(sheet: ExcelJS.Worksheet, spec: MatrixSpec, issues: ImportIssue[]): ExtractedMatrix | null {
  const header = findAnchor(sheet, spec.headerAnchor);
  if (!header) {
    issues.push({
      level: 'WARNING', field: null, sheet: spec.sheet, cell: null,
      message: `Could not find the "${spec.headerAnchor}" header on ${spec.sheet}. This matrix was skipped.`,
    });
    return null;
  }

  // Size labels run right from the header until a blank or "Total".
  const sizes: Array<{ name: string; col: number }> = [];
  for (let c = header.col + 1; c <= header.col + 40; c++) {
    const text = String(cellText(cellValue(sheet.getRow(header.row).getCell(c)))).trim();
    if (!text) continue;
    if (norm(text) === 'total') break;
    sizes.push({ name: text, col: c });
  }

  if (sizes.length === 0) {
    issues.push({
      level: 'WARNING', field: null, sheet: spec.sheet, cell: `${colLetter(header.col)}${header.row}`,
      message: `No size columns found next to "${spec.headerAnchor}" on ${spec.sheet}. `
        + `The sizes can be added on the order.`,
    });
    return null;
  }

  const rows: ExtractedMatrix['rows'] = [];
  let sheetTotal: number | null = null;

  for (let r = header.row + 1; r <= header.row + 60; r++) {
    const label = String(cellText(cellValue(sheet.getRow(r).getCell(header.col)))).trim();

    if (norm(label) === norm(spec.terminator)) {
      // The sheet's own grand total, for cross-checking.
      for (let c = header.col + 1; c <= header.col + 40; c++) {
        const headerText = norm(cellValue(sheet.getRow(header.row).getCell(c)));
        if (headerText === 'total') { sheetTotal = toNumber(cellValue(sheet.getRow(r).getCell(c))); break; }
      }
      break;
    }

    if (!label) continue; // a spare row, not the end of the data

    const cells: Record<string, number> = {};
    let rowTotal = 0;
    for (const s of sizes) {
      const n = toNumber(cellValue(sheet.getRow(r).getCell(s.col)));
      if (n != null && n > 0) { cells[s.name] = n; rowTotal += n; }
    }
    if (rowTotal > 0) rows.push({ color: label, cells, total: rowTotal });
  }

  const computedTotal = rows.reduce((a, r) => a + r.total, 0);

  // Reconcile against the sheet's own SUM. A mismatch means the file has stale
  // formula results or hidden rows, and the importer should say so rather than
  // silently disagree with the document the user is looking at.
  if (sheetTotal != null && sheetTotal !== computedTotal) {
    issues.push({
      level: 'WARNING', field: spec.ledger, sheet: spec.sheet, cell: null,
      message:
        `${spec.sheet}: the sheet's total says ${sheetTotal.toLocaleString()} but the rows add to ` +
        `${computedTotal.toLocaleString()}. The row values will be imported.`,
    });
  }

  return { ledger: spec.ledger, sizes: sizes.map((s) => s.name), rows, sheetTotal, computedTotal };
}

// ── BOM reader ──────────────────────────────────────────────────────────────

function extractBom(sheet: ExcelJS.Worksheet, headerAnchor: string, columns: Record<string, string>): ExtractedBomLine[] {
  const header = findAnchor(sheet, headerAnchor);
  if (!header) return [];

  // Map each logical field to the column holding its header text.
  const colOf: Record<string, number> = {};
  for (let c = header.col; c <= header.col + 25; c++) {
    const text = norm(cellValue(sheet.getRow(header.row).getCell(c)));
    if (!text) continue;
    for (const [field, label] of Object.entries(columns)) {
      if (colOf[field] == null && text.startsWith(norm(label))) colOf[field] = c;
    }
  }

  const lines: ExtractedBomLine[] = [];
  for (let r = header.row + 1; r <= header.row + 80; r++) {
    const row = sheet.getRow(r);
    const get = (f: string): unknown => (colOf[f] ? cellValue(row.getCell(colOf[f]!)) : null);

    const item = cellText(get('item')).trim() || null;
    const category = cellText(get('category')).trim() || null;
    const requiredQty = toNumber(get('requiredQty'));

    // An entirely empty row is a spare row, not the end — the sheet has many.
    if (!item && !category && requiredQty == null) continue;

    lines.push({
      category,
      position: cellText(get('position')).trim() || null,
      consumptionPerPiece: toNumber(get('consumptionPerPiece')),
      item,
      description: cellText(get('description')).trim() || null,
      color: cellText(get('color')).trim() || null,
      requiredQty,
      unit: cellText(get('unit')).trim() || null,
      issuedQty: toNumber(get('issuedQty')) ?? 0,
      issuedBy: cellText(get('issuedBy')).trim() || null,
      issuedTo: cellText(get('issuedTo')).trim() || null,
    });
  }
  return lines;
}

// ── Lay reader ──────────────────────────────────────────────────────────────

function extractLays(
  sheet: ExcelJS.Worksheet, headerAnchor: string, companion: string, terminator: string,
): ExtractedLay[] {
  const header = findHeaderRow(sheet, headerAnchor, companion);
  if (!header) return [];

  const wanted = ['fabric', 'color', 'panal', 'size', 'total', 'layers', 'total  length', 'nest', 'marker  length'];
  const colOf: Record<string, number> = {};
  for (let c = header.col; c <= header.col + 40; c++) {
    const text = norm(cellValue(sheet.getRow(header.row).getCell(c)));
    if (!text) continue;
    for (const w of wanted) if (colOf[w] == null && text.startsWith(norm(w))) colOf[w] = c;
  }

  const lays: ExtractedLay[] = [];
  for (let r = header.row + 1; r <= header.row + 40; r++) {
    const row = sheet.getRow(r);
    const first = String(cellText(cellValue(row.getCell(header.col)))).trim();
    if (norm(first) === norm(terminator)) break;
    if (!first) continue;

    const ratio = colOf['size'] ? cellText(cellValue(row.getCell(colOf['size']!))).trim() : '';
    const layers = colOf['layers'] ? toNumber(cellValue(row.getCell(colOf['layers']!))) : null;
    if (!ratio || !layers) continue;

    lays.push({
      fabric: first,
      color: colOf['color'] ? cellText(cellValue(row.getCell(colOf['color']!))).trim() || null : null,
      panel: colOf['panal'] ? cellText(cellValue(row.getCell(colOf['panal']!))).trim() || null : null,
      sizeRatio: ratio,
      layers,
      markerLengthM: colOf['marker  length'] ? toNumber(cellValue(row.getCell(colOf['marker  length']!))) : null,
      totalLengthM: colOf['total  length'] ? toNumber(cellValue(row.getCell(colOf['total  length']!))) : null,
      nestPcs: colOf['nest'] ? toNumber(cellValue(row.getCell(colOf['nest']!))) : null,
    });
  }
  return lays;
}

// ── Review-screen overrides ─────────────────────────────────────────────────

type OverrideType = FieldSpec['type'];

/** How a field typed on the review screen is read, and what it is called. */
function overrideSpec(field: string): { type: OverrideType; label: string } {
  // The profile knows percentages, which the concept table does not.
  const spec = PROFILES.flatMap((p) => p.fields).find((s) => s.field === field);
  if (spec) return { type: spec.type, label: spec.label };
  const meta = Object.values(CONCEPT_META).find((m) => m.field === field);
  if (meta) return { type: meta.type, label: meta.label };
  return { type: 'string', label: field };
}

/**
 * A number as somebody types it into a box.
 *
 * The file reader's `toNumber`, plus the one thing it cannot know: "5,50" in a
 * box is five and a half written the European way, never five hundred and
 * fifty. A thousands separator always has three digits after it, so a comma
 * followed by one or two is taken as the decimal point.
 */
function typedNumber(text: string): number | null {
  const t = text.trim();
  return toNumber(/^-?\d+,\d{1,2}$/.test(t) ? t.replace(',', '.') : t);
}

/**
 * One value typed on the review screen, read as the field it is for.
 *
 * These used to go through `new Date()` and `Number()` unchecked. A cleared
 * delivery date or a typed "13/09/2026" became an Invalid Date that Prisma
 * refused with a 500 — and as a PO date the same text quietly became today.
 * A cut percentage typed as 5 was stored as 500%. They now go through the same
 * readers the file does, the same "above 1 means a whole percentage" rule the
 * workbook gets, and the same bounds the order form enforces. Anything still
 * unreadable is refused by name, because a value somebody typed deliberately
 * must not be dropped quietly.
 */
export function parseFieldOverride(field: string, value: string | number | null): string | number | Date | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '') return null;

  const { type, label } = overrideSpec(field);
  switch (type) {
    case 'date': {
      const read = parseSpreadsheetDate(value);
      if (read.value) return read.value;
      // "TBC" and friends mean no date; only genuinely unreadable text is refused.
      if (read.problem) {
        throw new ValidationError(
          `${label}: “${text}” could not be read as a date. Enter it as e.g. 13/09/2026 or 2026-09-13.`,
          { field },
        );
      }
      return null;
    }
    case 'number': {
      const n = typedNumber(text);
      if (n == null) throw new ValidationError(`${label}: “${text}” is not a number.`, { field });
      return n;
    }
    case 'percent': {
      const hasSign = /%\s*$/.test(text);
      const n = typedNumber(text.replace(/%\s*$/, ''));
      if (n == null) throw new ValidationError(`${label}: “${text}” is not a percentage.`, { field });
      // "5%" and "5" both mean five per cent; "0.05" is already a fraction.
      const fraction = hasSign || n > 1 ? n / 100 : n;
      assertValidPercentage(fraction, label);
      return fraction;
    }
    default:
      return text;
  }
}

/**
 * Apply the review screen's values on top of an extraction, in place.
 *
 * Shared by every reader, so "Apply changes" means the same thing for a PDF or
 * a recognised workbook as it does for a generic table — and the preview the
 * coordinator approves is built from exactly what the commit will write. An
 * issue about a field somebody has now filled in is answered, and is dropped.
 */
export function applyFieldOverrides(
  extraction: Pick<ExtractionResult, 'fields' | 'issues'>,
  overrides: Record<string, string | number | null> | undefined,
): void {
  if (!overrides) return;
  const answered = new Set<string>();
  for (const [field, value] of Object.entries(overrides)) {
    const parsed = parseFieldOverride(field, value);
    extraction.fields[field] = parsed;
    if (parsed != null) answered.add(field);
  }
  extraction.issues = extraction.issues.filter(
    (i) => i.level === 'INFO' || i.field == null || !answered.has(i.field),
  );
}

// ── Fabric lines from the lay plan ──────────────────────────────────────────

/**
 * The BOM's fabric lines, as the AGE workbook derives them.
 *
 * Its BOM sheet shows them through `ANCHORARRAY('Laying fabric
 * instructions_Patr'!C46)`, and C46 is a LET over the lay plan: one line per
 * distinct fabric, panel and colour whose lays use any metres, with the metres
 * summed. Mirrored here column for column — Item Sort "Fabric", Position the
 * panel, Item the fabric, Color the colour, Order Qty the metres, Unit
 * "meter". Two columns are not copied: the formula writes the word "meter"
 * into Coms./Piece, which is not a consumption, and a fixed "100% Polyester"
 * into Description, which is a constant rather than anything the order says.
 */
export function fabricBomFromLays(lays: readonly ExtractedLay[]): ExtractedBomLine[] {
  const lines = new Map<string, ExtractedBomLine>();
  for (const lay of lays) {
    const fabric = (lay.fabric ?? '').trim();
    const color = (lay.color ?? '').trim();
    const metres = lay.totalLengthM ?? 0;
    if (!fabric || !color || !(metres > 0)) continue;
    const panel = (lay.panel ?? '').trim();
    const key = `${fabric}|${panel}|${color}`;
    const line = lines.get(key) ?? {
      category: 'Fabric', position: panel || null, consumptionPerPiece: null,
      item: fabric, description: null, color, requiredQty: 0, unit: 'meter',
      issuedQty: 0, issuedBy: null, issuedTo: null,
    };
    line.requiredQty = (line.requiredQty ?? 0) + metres;
    lines.set(key, line);
  }
  return [...lines.values()];
}

// ── Main entry ──────────────────────────────────────────────────────────────

export async function extractWorkbook(buffer: Buffer, forcedProfile?: ImportProfile): Promise<ExtractionResult> {
  const wb = await openWorkbook(buffer);

  const sheetNames = wb.worksheets.map((w) => w.name);
  const detected = forcedProfile
    ? { profile: forcedProfile, confidence: 1 }
    : detectProfile(sheetNames);

  const issues: ImportIssue[] = [];
  const sheets: ImportSheetInfo[] = wb.worksheets.map((w) => ({
    name: w.name,
    rows: w.rowCount,
    cols: w.columnCount,
    recognisedAs: detected.profile?.signature.names.find((n) => n.toLowerCase() === w.name.toLowerCase()) ?? null,
    confidence: detected.profile?.signature.names.some((n) => n.toLowerCase() === w.name.toLowerCase()) ? 1 : 0,
  }));

  if (!detected.profile) {
    issues.push({
      level: 'WARNING', field: null, sheet: null, cell: null,
      message:
        `This workbook does not match any known layout (best match ${Math.round(detected.confidence * 100)}%). ` +
        `Map the fields manually, or check that the sheet names are intact.`,
    });
    return {
      profileKey: null, confidence: detected.confidence, sheets, mappings: [],
      fields: {}, matrices: [], lineItems: [], bom: [], lays: [], externalColors: [], costing: {}, issues,
    };
  }

  const profile = detected.profile;
  const fields: Record<string, string | number | Date | null> = {};
  const mappings: ImportFieldMapping[] = [];

  // Every label the profile knows about, per sheet. A rightward scan that lands
  // on one of these has found a heading, not this field's value.
  const anchorsBySheet = new Map<string, Set<string>>();
  for (const spec of [...profile.fields, ...(profile.costing?.fields ?? [])]) {
    const set = anchorsBySheet.get(spec.sheet) ?? new Set<string>();
    set.add(norm(spec.anchor));
    anchorsBySheet.set(spec.sheet, set);
  }

  for (const spec of profile.fields) {
    const sheet = wb.getWorksheet(spec.sheet);
    if (!sheet) {
      issues.push({
        level: spec.required ? 'ERROR' : 'WARNING', field: spec.field, sheet: spec.sheet, cell: null,
        message: `Sheet "${spec.sheet}" is missing, so ${spec.label} could not be read.`,
      });
      mappings.push({
        field: spec.field, label: spec.label, sheet: spec.sheet, anchor: spec.anchor,
        offset: spec.offset, cell: null, sampleValue: null,
        required: !!spec.required, resolved: false, confidence: 'NONE',
        interpretation: `The sheet "${spec.sheet}" is not in this file`,
      });
      continue;
    }

    const { value, cell, found } = readAnchored(sheet, spec, anchorsBySheet.get(spec.sheet));

    let parsed: string | number | Date | null = null;
    if (value != null && !isExcelError(value)) {
      switch (spec.type) {
        case 'number':
        case 'percent': parsed = toNumber(value); break;
        case 'date': parsed = toDate(value); break;
        default: parsed = cellText(value).trim() || null;
      }
    } else if (isExcelError(value)) {
      // The source file legitimately contains #VALUE! and #DIV/0!. Report them
      // rather than importing the literal string.
      issues.push({
        level: 'WARNING', field: spec.field, sheet: spec.sheet, cell,
        message: `${spec.label} contains the Excel error ${cellText(value)} and was left empty.`,
      });
    }

    fields[spec.field] = parsed;

    if (spec.required && (parsed == null || parsed === '')) {
      issues.push({
        level: 'WARNING', field: spec.field, sheet: spec.sheet, cell,
        message: `${spec.label} is expected here but is empty${found ? '' : ' (anchor not found)'}. `
          + `Set it on the review screen, or on the order after importing.`,
      });
    }

    // Dates carry their own reading and its confidence: an 03/09 that could be
    // two different days is reported as such rather than silently resolved.
    const dateRead = spec.type === 'date' && value != null ? parseSpreadsheetDate(value) : null;

    mappings.push({
      field: spec.field, label: spec.label, sheet: spec.sheet, anchor: spec.anchor,
      offset: spec.offset,
      cell,
      sampleValue: isValidDate(parsed) ? toIsoDayOrNull(parsed) : parsed == null ? null : String(parsed),
      required: !!spec.required,
      resolved: found && parsed != null,
      confidence:
        parsed == null ? 'NONE'
        : dateRead ? dateRead.confidence
        // A value read from the cell an explicit anchor points at is as certain
        // as this importer gets: the label was found and the value was beside it.
        : 'HIGH',
      interpretation:
        dateRead?.interpretation
        ?? (cell ? `${spec.sheet} · ${cell}` : null),
      alternative:
        dateRead?.alternative
          ? {
              value: toIsoDayOrNull(dateRead.alternative.value) ?? '',
              interpretation: dateRead.alternative.interpretation,
            }
          : null,
    });
  }

  // Percentages arrive as fractions (0.05) in this workbook, but a user may
  // have typed 5. Normalise anything above 1 down by a hundred.
  for (const key of ['cutPercentage', 'accessoryPercentage']) {
    const v = fields[key];
    if (typeof v === 'number' && v > 1) {
      fields[key] = v / 100;
      issues.push({
        level: 'WARNING', field: key, sheet: null, cell: null,
        message: `${key} read as ${v} and was interpreted as ${v / 100} (${v}%).`,
      });
    }
  }

  const matrices: ExtractedMatrix[] = [];
  for (const m of profile.matrices) {
    const sheet = wb.getWorksheet(m.sheet);
    if (!sheet) continue;
    const extracted = extractMatrix(sheet, m, issues);
    if (extracted) matrices.push(extracted);
  }

  const orderMatrix = matrices.find((m) => m.ledger === 'ORDER');
  if (!orderMatrix || orderMatrix.rows.length === 0) {
    issues.push({
      level: 'WARNING', field: 'quantities', sheet: profile.matrices[0]?.sheet ?? null, cell: null,
      message: 'No order quantities were found in this file. The order will be created without a '
        + 'quantity grid, ready for the colours and quantities to be entered on it.',
    });
  }

  const bomSheet = profile.bom ? wb.getWorksheet(profile.bom.sheet) : null;
  const bom = bomSheet && profile.bom ? extractBom(bomSheet, profile.bom.headerAnchor, profile.bom.columns) : [];

  const laySheet = profile.lays ? wb.getWorksheet(profile.lays.sheet) : null;
  const lays = laySheet && profile.lays ? extractLays(laySheet, profile.lays.headerAnchor, profile.lays.companion, profile.lays.terminator) : [];

  // The workbook's fabric lines are not typed into the BOM sheet: they spill
  // there from a formula over the lay plan, and a spill carries no values the
  // reader can see unless Excel cached them — on the real AGE file it cached
  // #VALUE!, so the section read as empty. The same lines are rebuilt from the
  // lay plan the way that formula builds them. Only when the sheet yielded no
  // fabric of its own, so a file whose spill *was* cached is not read twice.
  if (!bom.some((l) => (l.category ?? '').trim().toLowerCase() === 'fabric')) {
    bom.push(...fabricBomFromLays(lays));
  }

  // External operation quantities per colour.
  const externalColors: ExtractionResult['externalColors'] = [];
  if (profile.external) {
    const sheet = wb.getWorksheet(profile.external.sheet);
    const extracted = sheet ? extractMatrix(sheet, { ledger: 'CUT', sheet: profile.external.sheet, headerAnchor: profile.external.headerAnchor, terminator: profile.external.terminator }, []) : null;
    if (extracted) {
      for (const row of extracted.rows) {
        externalColors.push({ color: row.color, qty: row.total, rate: null, area: null });
      }
    }
  }

  const costing: Record<string, number | null> = {};
  if (profile.costing) {
    const sheet = wb.getWorksheet(profile.costing.sheet);
    if (sheet) {
      for (const spec of profile.costing.fields) {
        const { value } = readAnchored(sheet, spec, anchorsBySheet.get(spec.sheet));
        costing[spec.field] = isExcelError(value) ? null : toNumber(value);
      }
    }
  }

  return {
    profileKey: profile.key,
    confidence: detected.confidence,
    sheets, mappings, fields, matrices, bom, lays, externalColors, costing, issues,
    // A profile-read workbook is a known layout with its own matrices; line
    // items are for the documents nobody has a profile for.
    lineItems: [],
  };
}

export { cellText, toNumber, toDate };
