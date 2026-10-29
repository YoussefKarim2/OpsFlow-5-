/**
 * Packing list reader.
 *
 * A packing file arrives in one of a handful of shapes, and the person who
 * attaches it wants to see what it says before anything else: the details at
 * the top (PO, client, ship date, address…), the carton table, and the totals.
 * This reads any of them into one layout:
 *
 *  - the factory's own "Packing_Coordinator" sheet: a title block of
 *    "Label : value" pairs, then "C/No | Size | Qty | Color | Total | Gw | Nw",
 *    one row per size, a mixed carton continuing on rows with no carton number;
 *  - a customer or forwarder list with the sizes across: "Ctn From | To |
 *    Ctns | Colour | XS S M L XL | Pcs/Ctn | Total | N.W | G.W | Meas.", one row
 *    per run of identical cartons;
 *  - the same as CSV, or as a PDF with a text layer.
 *
 * Every spreadsheet and PDF is first flattened to a grid of cell values, so the
 * reading below knows nothing about where the grid came from.
 *
 * Nothing here writes anything. The layout is shown back; what the coordinator
 * does with it is theirs.
 */

import type ExcelJS from 'exceljs';
import { openWorkbook, readCsvWorkbook } from './open-workbook.js';
import { detectFileKind, type FileKind } from './file-kind.js';
import { looksLikeSize } from './tabular-extractor.js';
import { isUncachedFormula } from './extractor.js';
import { readPdf, groupIntoRows, rowToPositionedCells, findTableBands, type PdfPage } from './pdf-extractor.js';
import { BadRequestError } from '../../errors.js';

// ── Output ──────────────────────────────────────────────────────────────────

export type PackingColumnRole =
  | 'CARTON_NO' | 'CARTON_FROM' | 'CARTON_TO' | 'CARTON_COUNT'
  | 'COLOUR' | 'SIZE' | 'QTY' | 'PCS_PER_CARTON' | 'TOTAL'
  | 'GROSS' | 'NET' | 'GROSS_TOTAL' | 'NET_TOTAL' | 'MEASUREMENT' | 'CBM'
  | 'STYLE' | 'PO' | 'SIZE_COLUMN' | 'OTHER';

export interface PackingCarton {
  /** As the document writes it: "7", "1-10", "CTN-004". */
  number: string;
  /** How many identical cartons the row stands for: 10 for "1-10". */
  count: number;
  colour: string | null;
  style: string | null;
  /** Pieces in one carton, by size as the document names it. */
  bySize: Record<string, number>;
  /** Pieces in one carton. */
  perCarton: number;
  /** Pieces in all the cartons of the row. */
  totalPieces: number;
  /** Weights for one carton, kg. */
  grossKg: number | null;
  netKg: number | null;
  measurement: string | null;
  /** The document's own row (1-based), and the last one when a mixed carton runs over several. */
  sheetRow: number;
  lastRow: number;
}

export interface PackingTotals {
  cartons: number;
  pieces: number;
  grossKg: number | null;
  netKg: number | null;
  bySize: Record<string, number>;
  byColour: Record<string, number>;
}

export interface PackingIssue {
  level: 'INFO' | 'WARNING';
  message: string;
}

/** A cell of the preview grid. */
export interface PreviewCell {
  text: string;
  /** Columns the cell spans (a merge), 1 when it is on its own. */
  span?: number;
}

export interface PackingLayout {
  fileKind: FileKind;
  sheetName: string | null;
  sheets: string[];
  /** "Label : value" pairs at the top, in reading order. */
  details: Array<{ label: string; value: string }>;
  /** Free lines above the table that are not label/value pairs: titles. */
  titles: string[];
  table: {
    /** 1-based row of the header in the document (the last row of a two-row header). */
    headerRow: number;
    shape: 'ROW_PER_SIZE' | 'SIZES_ACROSS' | 'ROW_PER_CARTON';
    columns: Array<{ index: number; heading: string; role: PackingColumnRole }>;
    sizes: string[];
  } | null;
  cartons: PackingCarton[];
  totals: PackingTotals;
  /** What the document's own TOTAL row says, when it has one. */
  printedTotals: { pieces: number | null; cartons: number | null; grossKg: number | null; netKg: number | null; sheetRow: number } | null;
  /** The document as it looks: the first rows, trimmed to the columns in use. */
  preview: {
    firstColumn: number;
    rows: Array<{ row: number; cells: PreviewCell[]; kind: 'HEADER' | 'CARTON' | 'TOTAL' | 'DETAIL' | 'OTHER' }>;
    truncated: boolean;
  };
  issues: PackingIssue[];
}

// ── The grid ────────────────────────────────────────────────────────────────

type Cell = string | number | null;
interface Grid {
  name: string;
  rows: Cell[][];
  /** Spans of merged cells, keyed "row:col" (0-based) of the top-left cell. */
  spans: Map<string, number>;
  uncached: number;
}

const MAX_ROWS = 2000;
const MAX_COLS = 60;

function excelValue(v: ExcelJS.CellValue): Cell {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('error' in o) return null;
    if ('richText' in o && Array.isArray(o.richText)) {
      const t = (o.richText as Array<{ text: string }>).map((r) => r.text).join('').trim();
      return t === '' ? null : t;
    }
    if ('result' in o) return o.result == null ? null : excelValue(o.result as ExcelJS.CellValue);
    if ('text' in o && typeof o.text === 'string') return o.text.trim() || null;
  }
  return null;
}

function sheetToGrid(ws: ExcelJS.Worksheet): Grid {
  const rows: Cell[][] = [];
  const spans = new Map<string, number>();
  let uncached = 0;
  const lastRow = Math.min(ws.rowCount, MAX_ROWS);
  const lastCol = Math.min(ws.columnCount, MAX_COLS);
  for (let r = 1; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const out: Cell[] = [];
    for (let c = 1; c <= lastCol; c++) {
      const cell = row.getCell(c);
      if (cell.isMerged && cell.master !== cell) { out.push(null); continue; }
      if (isUncachedFormula(cell.value)) uncached++;
      out.push(excelValue(cell.value));
    }
    rows.push(out);
  }
  // Horizontal spans of merges, for the preview.
  for (const range of (ws.model as { merges?: string[] }).merges ?? []) {
    const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) continue;
    const c0 = colIndex(m[1]!); const c1 = colIndex(m[3]!);
    spans.set(`${Number(m[2]) - 1}:${c0 - 1}`, c1 - c0 + 1);
  }
  return { name: ws.name, rows, spans, uncached };
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** A PDF as one grid: table bands aligned to their own columns, the rest cell by cell. */
function pdfToGrid(pages: PdfPage[]): Grid {
  const rows: Cell[][] = [];
  for (const page of pages) {
    const lines = groupIntoRows(page.items).map(rowToPositionedCells).filter((l) => l.length > 0);
    const bands = findTableBands(lines);
    for (let i = 0; i < lines.length; i++) {
      const band = bands.find((b) => b.start === i);
      if (band) {
        for (const r of band.rows) rows.push(r.map(pdfValue));
        i += band.rows.length - 1;
        continue;
      }
      rows.push(lines[i]!.map((c) => pdfValue(c.text)));
    }
  }
  return { name: 'PDF', rows: rows.slice(0, MAX_ROWS), spans: new Map(), uncached: 0 };
}

function pdfValue(t: string): Cell {
  const s = t.trim();
  if (s === '') return null;
  const n = Number(s.replace(/,/g, ''));
  return /^-?[\d,]+(\.\d+)?$/.test(s) && Number.isFinite(n) ? n : s;
}

// ── Reading the cells ───────────────────────────────────────────────────────

const text = (c: Cell): string => (c == null ? '' : String(c).trim());

function num(c: Cell): number | null {
  if (c == null) return null;
  if (typeof c === 'number') return c;
  const s = c.replace(/\s*(kgs?|pcs|pieces|pc|ctns?|cartons?)\.?\s*$/i, '').replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Lower case, punctuation to spaces: "N.W. (Kgs)" → "n w kgs". */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9#/%]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Starts with a symbol or emoji: the factory template's navigation column, not content. */
const isDecoration = (s: string): boolean => /^[^\p{L}\p{N}(]/u.test(s);

function roleOf(heading: string): PackingColumnRole | null {
  const h = norm(heading);
  if (!h) return null;
  const total = /\btotal\b|\btot\b/.test(h);
  if (/^(c ?no|c\/no|ctn ?no|ctns? ?#|carton ?(no|number|#|nos)|box ?(no|number)|carton|ctn|cartons? ?no s?|ctn nos?)$/.test(h)) return 'CARTON_NO';
  if (/^(from|ctn ?from|carton ?from|from ?ctn|from ?no)$/.test(h)) return 'CARTON_FROM';
  if (/^(to|ctn ?to|carton ?to|to ?ctn|to ?no)$/.test(h)) return 'CARTON_TO';
  if (/^(no ?of ?(ctns?|cartons?)|(total ?)?(ctns?|cartons)|(ctn|carton) ?(qty|count)|qty ?of ?(ctns?|cartons?)|cartonqty|#? ?ctns?)$/.test(h)) return 'CARTON_COUNT';
  if (/^(colou?rs?|colou?r ?(name|code|way)?|col|shade|colorway)$/.test(h)) return 'COLOUR';
  if (/^size( ?name)?$|^sizes$/.test(h)) return 'SIZE';
  if (/(pcs|qty|pieces|quantity|units?)( ?\/ ?| ?per ?| ?in ?)(ctn|carton|box)|^(pcs|qty) ?(ctn|carton)$|^ctn ?qty$/.test(h)) return 'PCS_PER_CARTON';
  if (/^(g ?w|gross( ?w(eigh)?t)?|gr ?wt)\b/.test(h) || /\bgross\b/.test(h)) return total ? 'GROSS_TOTAL' : 'GROSS';
  if (/^(n ?w|net( ?w(eigh)?t)?|nt ?wt)\b/.test(h) || /\bnet\b/.test(h)) return total ? 'NET_TOTAL' : 'NET';
  if (/\bcbm\b|\bm3\b|volume/.test(h)) return 'CBM';
  if (/meas|dimension|\bdims?\b|l ?x ?w|ctn ?size|carton ?size|box ?size/.test(h)) return 'MEASUREMENT';
  if (/^(total|total ?(qty|pcs|pieces|quantity|units)|qty ?total|grand ?total|ttl( ?pcs)?)$/.test(h)) return 'TOTAL';
  // "Units" is pieces; "Unit" alone is the unit of measure (pce, set).
  if (/^(qty|quantity|pcs|pieces|units|qty ?pcs)$/.test(h)) return 'QTY';
  if (/^(style|style ?(no|#|name)|article|art ?no|item|item ?no|model|description)$/.test(h)) return 'STYLE';
  if (/^(po|po ?(no|#|number)|order ?(no|#))$/.test(h)) return 'PO';
  return null;
}

/** Labels of the title block that are known without a colon. */
const KNOWN_LABEL = /^(po|po ?(no|#|number)|po ?date|order ?(no|name|date)|invoice ?(no|#|date)|date|style ?(no|#)?|season|client|buyer|customer|consignee|shipper|exporter|notify ?party|destination|port ?of ?(loading|discharge)|vessel|container ?(no)?|seal ?(no)?|bl ?no|awb ?no|method ?of ?shipping|ship ?(via|mode|date)|shipping ?(date|method|mode)|(shipping|billing|delivery) ?ad+r?ess|delivery ?date|required ?delivery ?date|prom+is+ed ?shipping ?date|coordinator|item ?type|gender|fabric|description|brand|country ?of ?origin|origin|terms|payment ?terms|incoterms?|price( ?in ?us)?|cut ?percentage|packing ?inst)$/;

const isLabelText = (s: string): boolean => {
  if (!s || isDecoration(s) || s.length > 40) return false;
  if (/[:：]\s*$/.test(s)) return true;
  return KNOWN_LABEL.test(norm(s.replace(/[:：]\s*$/, '')));
};

const cleanLabel = (s: string): string => s.replace(/\s*[:：]\s*$/, '').replace(/\s+/g, ' ').trim();

function displayValue(c: Cell): string {
  if (typeof c === 'number') return Number.isInteger(c) ? String(c) : String(Math.round(c * 1000) / 1000);
  return text(c);
}

// ── Finding the table ───────────────────────────────────────────────────────

interface HeaderPick {
  row: number; // 0-based, the row the data follows
  /** The header takes two rows: `row` and the one above it. */
  twoRow: boolean;
  columns: Array<{ index: number; heading: string; role: PackingColumnRole }>;
  score: number;
}

function headingAt(grid: Grid, r: number, c: number, twoRow: boolean): string {
  const own = text(grid.rows[r]?.[c] ?? null);
  if (!twoRow) return own;
  // A two-row header: "Carton No." over "From | To", "Weight" over "N.W | G.W".
  // The lower cell names the column; the upper one, often merged across it,
  // says what it belongs to. The parent is the nearest text at or left of this
  // column on the row above, within its merge.
  const up = grid.rows[r - 1] ?? [];
  let parent = text(up[c] ?? null);
  if (!parent) {
    for (let k = c - 1; k >= 0 && k >= c - 6; k--) {
      const t = text(up[k] ?? null);
      if (t) { const span = grid.spans.get(`${r - 1}:${k}`) ?? 1; if (k + span > c) parent = t; break; }
    }
  }
  if (!own) return parent;
  if (!parent || parent === own) return own;
  return `${parent} ${own}`;
}

function analyseHeader(grid: Grid, r: number, orderSizes: ReadonlySet<string>): HeaderPick | null {
  const row = grid.rows[r] ?? [];
  const nonEmpty = row.filter((c) => c != null);
  if (nonEmpty.length < 2) return null;
  // A header is words: a row that is mostly numbers is data, and so is one
  // that starts with a number — a carton number, the first cell of a row.
  if (nonEmpty.filter((c) => typeof c === 'number').length > nonEmpty.length / 2) return null;
  if (typeof nonEmpty[0] === 'number') return null;

  const below = grid.rows[r + 1] ?? [];

  const build = (rowIdx: number, two: boolean) => {
    const cols: HeaderPick['columns'] = [];
    const width = Math.max(grid.rows[rowIdx]?.length ?? 0, two ? grid.rows[rowIdx - 1]?.length ?? 0 : 0);
    for (let c = 0; c < width; c++) {
      const own = text(grid.rows[rowIdx]?.[c] ?? null);
      const heading = headingAt(grid, rowIdx, c, two);
      if (!heading) continue;
      let role = roleOf(own) ?? roleOf(heading);
      // A parent heading names the pair: "Carton No" over "From | To".
      if (two && (role === 'CARTON_NO' || role == null) && /^(from)$/i.test(norm(own))) role = 'CARTON_FROM';
      if (two && (role === 'CARTON_NO' || role == null) && /^(to)$/i.test(norm(own))) role = 'CARTON_TO';
      if (role == null && (orderSizes.has(norm(own)) || (own.length <= 8 && looksLikeSize(own)))) role = 'SIZE_COLUMN';
      // A size keeps its own name: "YXS" under a "Size" heading is YXS.
      cols.push({ index: c, heading: role === 'SIZE_COLUMN' ? own : heading, role: role ?? 'OTHER' });
    }
    return cols;
  };

  const score = (cols: HeaderPick['columns']) => {
    const has = (x: PackingColumnRole) => cols.some((c) => c.role === x);
    const carton = has('CARTON_NO') || has('CARTON_FROM') || has('CARTON_COUNT');
    const sizes = cols.filter((c) => c.role === 'SIZE_COLUMN').length;
    const pieces = has('QTY') || has('TOTAL') || has('PCS_PER_CARTON') || sizes >= 2;
    if (!carton || !pieces) return 0;
    return cols.filter((c) => c.role !== 'OTHER' && c.role !== 'SIZE_COLUMN').length * 2 + Math.min(sizes, 6)
      + (has('COLOUR') ? 2 : 0) + (has('GROSS') || has('NET') || has('GROSS_TOTAL') || has('NET_TOTAL') ? 2 : 0);
  };

  let best: HeaderPick | null = null;
  const one = build(r, false);
  const s1 = score(one);
  if (s1 > 0) best = { row: r, twoRow: false, columns: one, score: s1 };
  // The row below may be the second line of this header.
  if (r + 1 < grid.rows.length) {
    const belowNumbers = below.filter((c) => typeof c === 'number').length;
    const belowWords = below.filter((c) => typeof c === 'string').length;
    if (belowWords >= 2 && belowNumbers <= 1) {
      const two = build(r + 1, true);
      const s2 = score(two);
      if (s2 > (best?.score ?? 0)) best = { row: r + 1, twoRow: true, columns: two, score: s2 };
    }
  }
  return best;
}

function findHeader(grid: Grid, orderSizes: ReadonlySet<string>): HeaderPick | null {
  let best: HeaderPick | null = null;
  const limit = Math.min(grid.rows.length, 400);
  for (let r = 0; r < limit; r++) {
    const pick = analyseHeader(grid, r, orderSizes);
    if (pick && pick.score > (best?.score ?? 0)) best = pick;
  }
  return best;
}

// ── Reading the cartons ─────────────────────────────────────────────────────

/** "1-10", "001 ~ 010", "1 to 10", "1/10" → [1, 10]; "7" → [7, 7]; else null. */
export function cartonRange(raw: string): [number, number] | null {
  const s = raw.trim();
  const single = s.match(/^(?:[A-Za-z#.\- ]*?)(\d+)$/);
  const range = s.match(/^(?:[A-Za-z#.\- ]*?)(\d+)\s*(?:-|–|—|~|to|\/|:)\s*(?:[A-Za-z#.\- ]*?)(\d+)$/i);
  if (range) {
    const a = Number(range[1]); const b = Number(range[2]);
    if (b >= a && b - a < 10_000) return [a, b];
    return null;
  }
  if (single) return [Number(single[1]), Number(single[1])];
  return null;
}

const isTotalRow = (row: Cell[]): boolean =>
  row.some((c) => typeof c === 'string' && /^(grand\s*)?(total|totals|ttl|sum)\b\s*[:：]?/i.test(c.trim()));

function readCartons(grid: Grid, header: HeaderPick, issues: PackingIssue[]) {
  const col = (role: PackingColumnRole) => header.columns.find((c) => c.role === role)?.index;
  const cNo = col('CARTON_NO'); const cFrom = col('CARTON_FROM'); const cTo = col('CARTON_TO');
  const cCount = col('CARTON_COUNT'); const cColour = col('COLOUR'); const cSize = col('SIZE');
  const cQty = col('QTY'); const cPer = col('PCS_PER_CARTON'); const cTotal = col('TOTAL');
  const cGross = col('GROSS'); const cNet = col('NET'); const cGrossT = col('GROSS_TOTAL'); const cNetT = col('NET_TOTAL');
  const cMeas = col('MEASUREMENT'); const cStyle = col('STYLE');
  const sizeCols = header.columns.filter((c) => c.role === 'SIZE_COLUMN');

  const shape: NonNullable<PackingLayout['table']>['shape'] = sizeCols.length >= 1 && cSize == null
    ? 'SIZES_ACROSS'
    : cSize != null ? 'ROW_PER_SIZE' : 'ROW_PER_CARTON';

  const cartons: PackingCarton[] = [];
  const rowKinds = new Map<number, 'CARTON' | 'TOTAL'>();
  let printed: PackingLayout['printedTotals'] = null;
  let blankRun = 0;
  let lastColour: string | null = null;
  let lastStyle: string | null = null;
  let unreadable = 0;

  for (let r = header.row + 1; r < grid.rows.length; r++) {
    const row = grid.rows[r] ?? [];
    const at = (i: number | undefined): Cell => (i == null ? null : row[i] ?? null);
    const used = header.columns.some((c) => at(c.index) != null);
    if (!used) {
      if (++blankRun >= 3 && cartons.length > 0) break;
      continue;
    }
    blankRun = 0;

    if (isTotalRow(row)) {
      const sumSizes = sizeCols.reduce((a, c) => a + (num(at(c.index)) ?? 0), 0);
      // A PDF's total line is often too short to sit under the table's
      // columns; its one number is then the pieces.
      const loose = row.map(num).filter((n): n is number => n != null);
      printed = {
        pieces: num(at(cTotal)) ?? num(at(cQty)) ?? (sumSizes > 0 ? sumSizes : null) ?? (loose.length === 1 ? loose[0]! : null),
        cartons: num(at(cCount)) ?? null,
        grossKg: num(at(cGrossT)) ?? num(at(cGross)),
        netKg: num(at(cNetT)) ?? num(at(cNet)),
        sheetRow: r + 1,
      };
      rowKinds.set(r, 'TOTAL');
      break;
    }
    // A second header repeated further down (a page break in a PDF): skip it.
    if (header.columns.filter((c) => c.role !== 'OTHER' && typeof at(c.index) === 'string' && roleOf(text(at(c.index))) === c.role).length >= 2) continue;

    // The carton number(s).
    let numberText = '';
    let range: [number, number] | null = null;
    if (cFrom != null && num(at(cFrom)) != null) {
      const a = num(at(cFrom))!; const b = num(at(cTo)) ?? a;
      range = b >= a ? [a, b] : [a, a];
      numberText = a === range[1] ? String(a) : `${a}-${range[1]}`;
    } else if (cNo != null && at(cNo) != null) {
      numberText = displayValue(at(cNo)).replace(/,/g, '');
      range = cartonRange(numberText);
    }
    const countCell = num(at(cCount));
    const count = countCell != null && countCell > 0 ? Math.round(countCell) : range ? range[1] - range[0] + 1 : 1;

    const colourCell = text(at(cColour)) || null;
    const styleCell = text(at(cStyle)) || null;

    // Pieces.
    const bySize: Record<string, number> = {};
    if (shape === 'SIZES_ACROSS') {
      for (const s of sizeCols) {
        const n = num(at(s.index));
        if (n != null && n > 0) bySize[s.heading] = (bySize[s.heading] ?? 0) + n;
      }
    } else if (shape === 'ROW_PER_SIZE') {
      const size = text(at(cSize));
      const n = num(at(cQty)) ?? num(at(cPer)) ?? (cTotal != null && !numberText ? num(at(cTotal)) : null);
      if (size && n != null && n > 0) bySize[size] = n;
    }
    let perCarton = Object.values(bySize).reduce((a, b) => a + b, 0);
    if (shape === 'ROW_PER_CARTON') {
      const per = num(at(cPer));
      const qty = num(at(cQty)) ?? num(at(cTotal));
      // A line with no carton number but a carton count — a summary by style,
      // "1,092 pcs in 10 cartons" — gives the pieces of the whole line.
      perCarton = per ?? (qty != null && cNo == null && cFrom == null && count > 1 ? qty / count : qty ?? 0);
    }

    // A row with no carton number continues the carton above: the factory
    // sheet lists a mixed carton one size per row, numbering only the first.
    if (!numberText && cartons.length > 0 && perCarton > 0 && shape === 'ROW_PER_SIZE') {
      const prev = cartons[cartons.length - 1]!;
      for (const [s, n] of Object.entries(bySize)) prev.bySize[s] = (prev.bySize[s] ?? 0) + n;
      prev.perCarton += perCarton;
      prev.totalPieces = prev.perCarton * prev.count;
      prev.lastRow = r + 1;
      if (prev.grossKg == null) prev.grossKg = num(at(cGross));
      if (prev.netKg == null) prev.netKg = num(at(cNet));
      rowKinds.set(r, 'CARTON');
      continue;
    }
    if (!numberText && perCarton === 0 && countCell == null) {
      if (cartons.length > 0) unreadable++;
      continue;
    }
    if (perCarton === 0 && numberText) {
      // A numbered carton with no pieces: kept, so the count of boxes is right, and said.
      issues.push({ level: 'WARNING', message: `Row ${r + 1}: carton ${numberText} has no pieces in it.` });
    }

    const colour = colourCell ?? lastColour;
    const style = styleCell ?? lastStyle;
    if (colourCell) lastColour = colourCell;
    if (styleCell) lastStyle = styleCell;

    // Sizes across with a range: the size cells are usually per carton and the
    // Total the whole run. When the sizes already add up to the Total, they
    // were for the whole run, and one carton holds its share.
    const printedTotal = num(at(cTotal));
    if (shape === 'SIZES_ACROSS' && count > 1 && printedTotal != null && perCarton === printedTotal && perCarton % count === 0) {
      for (const k of Object.keys(bySize)) bySize[k] = bySize[k]! / count;
      perCarton = perCarton / count;
    }

    const gross = num(at(cGross)) ?? (num(at(cGrossT)) != null ? num(at(cGrossT))! / count : null);
    const net = num(at(cNet)) ?? (num(at(cNetT)) != null ? num(at(cNetT))! / count : null);

    cartons.push({
      // No number on a summary line; the screen shows a dash.
      number: numberText,
      count,
      colour,
      style,
      bySize,
      perCarton,
      totalPieces: perCarton * count,
      grossKg: gross,
      netKg: net,
      measurement: text(at(cMeas)) || null,
      sheetRow: r + 1,
      lastRow: r + 1,
    });
    rowKinds.set(r, 'CARTON');

    if (printedTotal != null && cTotal != null && shape !== 'ROW_PER_SIZE' && Math.abs(printedTotal - perCarton * count) > 0.001 && Math.abs(printedTotal - perCarton) > 0.001) {
      issues.push({ level: 'WARNING', message: `Row ${r + 1}: the row's total says ${printedTotal.toLocaleString('en-US')} pcs, but ${count} carton${count === 1 ? '' : 's'} × ${perCarton.toLocaleString('en-US')} pcs is ${(perCarton * count).toLocaleString('en-US')}.` });
    }
  }
  if (unreadable > 0) {
    issues.push({ level: 'WARNING', message: `${unreadable} row${unreadable === 1 ? '' : 's'} under the table had neither a carton number nor pieces, and ${unreadable === 1 ? 'was' : 'were'} not read.` });
  }
  return { cartons, shape, printed, rowKinds, sizes: shape === 'SIZES_ACROSS' ? sizeCols.map((c) => c.heading) : null };
}

// ── The title block ─────────────────────────────────────────────────────────

function readDetails(grid: Grid, upTo: number) {
  const details: Array<{ label: string; value: string }> = [];
  const titles: string[] = [];
  const detailRows = new Set<number>();
  for (let r = 0; r < upTo; r++) {
    const row = grid.rows[r] ?? [];
    const used = new Set<number>();
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell == null || used.has(c) || typeof cell !== 'string') continue;
      const t = cell.trim();
      if (isDecoration(t)) { used.add(c); continue; }
      // "PO No: 12345" in one cell.
      const inline = t.match(/^([^:：]{2,30}?)\s*[:：]\s*(.+)$/);
      if (inline && !/^https?$/i.test(inline[1]!)) {
        details.push({ label: cleanLabel(inline[1]!), value: inline[2]!.trim() });
        used.add(c); detailRows.add(r);
        continue;
      }
      if (isLabelText(t)) {
        // Its value is the next cell to the right that is not itself a label.
        let value: Cell = null;
        for (let k = c + 1; k < Math.min(row.length, c + 8); k++) {
          const v = row[k];
          if (v == null) continue;
          if (typeof v === 'string' && isLabelText(v.trim())) break;
          value = v; used.add(k); break;
        }
        used.add(c); detailRows.add(r);
        // A label left blank is shown blank: the layout is what the document says.
        details.push({ label: cleanLabel(t), value: value == null ? '' : displayValue(value) });
        continue;
      }
    }
    // What is left on the row is a title, when the row has nothing else.
    const rest = row.map((c, i) => (used.has(i) ? null : c)).filter((c) => c != null && !(typeof c === 'string' && isDecoration(c)));
    if (rest.length === 1 && typeof rest[0] === 'string' && titles.length < 6 && rest[0].length <= 80) {
      titles.push(rest[0]);
      detailRows.add(r);
    }
  }
  return { details, titles, detailRows };
}

// ── Putting it together ─────────────────────────────────────────────────────

export interface PackingReadOptions {
  /** The order's size names, so a column headed "Adult Medium" is a size. */
  orderSizes?: readonly string[];
  /** Injected in tests so the suite never loads a PDF engine. */
  pdfReader?: (buffer: Buffer) => Promise<PdfPage[]>;
}

export async function readPackingDocument(buffer: Buffer, fileName: string, options: PackingReadOptions = {}): Promise<PackingLayout> {
  const kind = detectFileKind(buffer, fileName);
  const orderSizes = new Set((options.orderSizes ?? []).map(norm));

  let grids: Grid[];
  if (kind === 'pdf') {
    const pages = await (options.pdfReader ?? readPdf)(buffer);
    if (pages.every((p) => p.items.length === 0)) {
      throw new BadRequestError('This PDF has no text in it — it is a scan or a photograph — so it cannot be read. Ask for the original Excel file or a PDF exported from it.');
    }
    grids = [pdfToGrid(pages)];
  } else {
    const wb = kind === 'csv' ? await readCsvWorkbook(buffer) : await openWorkbook(buffer);
    grids = wb.worksheets.filter((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden').map(sheetToGrid);
    if (grids.length === 0) grids = wb.worksheets.map(sheetToGrid);
  }

  // The sheet with the best carton table; a sheet named for packing wins a tie.
  const picks = grids.map((g) => ({ g, h: findHeader(g, orderSizes) }));
  picks.sort((a, b) => (b.h?.score ?? 0) - (a.h?.score ?? 0)
    || Number(/pack/i.test(b.g.name)) - Number(/pack/i.test(a.g.name)));
  const chosen = picks[0]!;
  const grid = chosen.g;
  const header = chosen.h;
  const issues: PackingIssue[] = [];

  let table: PackingLayout['table'] = null;
  let cartons: PackingCarton[] = [];
  let printed: PackingLayout['printedTotals'] = null;
  let rowKinds = new Map<number, 'CARTON' | 'TOTAL'>();
  if (header) {
    const read = readCartons(grid, header, issues);
    cartons = read.cartons; printed = read.printed; rowKinds = read.rowKinds;
    const sizesSeen: string[] = read.sizes ?? [];
    if (!read.sizes) for (const c of cartons) for (const s of Object.keys(c.bySize)) if (!sizesSeen.includes(s)) sizesSeen.push(s);
    table = { headerRow: header.row + 1, shape: read.shape, columns: header.columns, sizes: sizesSeen };
  } else {
    issues.push({ level: 'WARNING', message: 'No carton table was found: no row has a carton column (C/No, Ctn No, From/To or No. of cartons) next to pieces or sizes. The document is shown as it is.' });
  }

  const { details, titles, detailRows } = readDetails(grid, header ? header.row - (header.twoRow ? 1 : 0) : Math.min(grid.rows.length, 40));

  // Totals.
  const totals: PackingTotals = { cartons: 0, pieces: 0, grossKg: null, netKg: null, bySize: {}, byColour: {} };
  for (const c of cartons) {
    totals.cartons += c.count;
    totals.pieces += c.totalPieces;
    if (c.grossKg != null) totals.grossKg = (totals.grossKg ?? 0) + c.grossKg * c.count;
    if (c.netKg != null) totals.netKg = (totals.netKg ?? 0) + c.netKg * c.count;
    for (const [s, n] of Object.entries(c.bySize)) totals.bySize[s] = (totals.bySize[s] ?? 0) + n * c.count;
    const k = c.colour ?? '—';
    totals.byColour[k] = (totals.byColour[k] ?? 0) + c.totalPieces;
  }
  const round = (n: number | null) => (n == null ? null : Math.round(n * 1000) / 1000);
  totals.grossKg = round(totals.grossKg); totals.netKg = round(totals.netKg);

  if (printed) {
    const differs = (a: number | null, b: number | null, tol: number) => a != null && b != null && Math.abs(a - b) > tol;
    if (differs(printed.pieces, totals.pieces, 0.5)) issues.push({ level: 'WARNING', message: `The document's TOTAL row says ${printed.pieces!.toLocaleString('en-US')} pcs, but its cartons add up to ${totals.pieces.toLocaleString('en-US')}.` });
    if (differs(printed.cartons, totals.cartons, 0.5)) issues.push({ level: 'WARNING', message: `The document's TOTAL row says ${printed.cartons} cartons, but ${totals.cartons} were read.` });
    if (differs(printed.grossKg, totals.grossKg, 0.6)) issues.push({ level: 'WARNING', message: `The document's TOTAL row says ${printed.grossKg} kg gross, but the cartons add up to ${totals.grossKg} kg.` });
    if (differs(printed.netKg, totals.netKg, 0.6)) issues.push({ level: 'WARNING', message: `The document's TOTAL row says ${printed.netKg} kg net, but the cartons add up to ${totals.netKg} kg.` });
  }
  const heavy = cartons.filter((c) => c.grossKg != null && c.netKg != null && c.netKg > c.grossKg);
  if (heavy.length > 0) issues.push({ level: 'WARNING', message: `Net weight is more than gross weight on carton${heavy.length === 1 ? '' : 's'} ${heavy.slice(0, 5).map((c) => c.number).join(', ')}.` });
  const numbers = new Map<string, number>();
  for (const c of cartons) if (c.number) numbers.set(c.number.toUpperCase(), (numbers.get(c.number.toUpperCase()) ?? 0) + 1);
  const repeated = [...numbers.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (repeated.length > 0) issues.push({ level: 'WARNING', message: `Carton number${repeated.length === 1 ? '' : 's'} ${repeated.slice(0, 5).join(', ')} appear${repeated.length === 1 ? 's' : ''} more than once.` });
  if (grid.uncached > 0) issues.push({ level: 'WARNING', message: `${grid.uncached} formula cell${grid.uncached === 1 ? ' has' : 's have'} no saved result, so ${grid.uncached === 1 ? 'it reads' : 'they read'} as empty. Open the file in Excel, save it, and attach it again.` });
  if (header && cartons.length === 0) issues.push({ level: 'WARNING', message: `The carton table on row ${header.row + 1} has no cartons under it yet.` });
  if (grids.length > 1) issues.push({ level: 'INFO', message: `Read the sheet "${grid.name}" — ${grids.length} sheets in the file.` });

  return {
    fileKind: kind,
    sheetName: kind === 'pdf' ? null : grid.name,
    sheets: grids.map((g) => g.name),
    details, titles, table, cartons, totals, printedTotals: printed,
    preview: buildPreview(grid, header?.row ?? null, header?.twoRow ? header.row - 1 : null, rowKinds, detailRows),
    issues,
  };
}

// ── The preview ─────────────────────────────────────────────────────────────

const PREVIEW_ROWS = 80;

function buildPreview(
  grid: Grid, headerRow: number | null, upperHeader: number | null,
  rowKinds: ReadonlyMap<number, 'CARTON' | 'TOTAL'>, detailRows: ReadonlySet<number>,
): PackingLayout['preview'] {
  // Columns in use, without the decoration column the factory template keeps on the left.
  let first = Infinity; let last = -1;
  for (const row of grid.rows) {
    row.forEach((c, i) => {
      if (c == null || (typeof c === 'string' && isDecoration(c))) return;
      first = Math.min(first, i); last = Math.max(last, i);
    });
  }
  if (last < 0) return { firstColumn: 1, rows: [], truncated: false };
  last = Math.min(last, first + 29);

  // From the first row with content, to the end of the table (or the preview cap).
  let start = grid.rows.findIndex((row) => row.slice(first, last + 1).some((c) => c != null && !(typeof c === 'string' && isDecoration(c))));
  if (start < 0) start = 0;
  const lastTableRow = Math.max(-1, ...rowKinds.keys());
  let end = headerRow == null ? grid.rows.length : Math.max(lastTableRow, headerRow) + 2;
  if (end <= start) end = grid.rows.length;
  end = Math.min(end, grid.rows.length);

  const rows: PackingLayout['preview']['rows'] = [];
  for (let r = start; r < end && rows.length < PREVIEW_ROWS; r++) {
    const row = grid.rows[r] ?? [];
    const slice = row.slice(first, last + 1);
    if (slice.every((c) => c == null) && r !== headerRow) {
      // One blank row stands for a run of them.
      if (rows.length > 0 && rows[rows.length - 1]!.cells.every((c) => c.text === '')) continue;
    }
    const cells: PreviewCell[] = [];
    for (let c = first; c <= last; c++) {
      const v = row[c] ?? null;
      const t = typeof v === 'string' && isDecoration(v) ? '' : displayValue(v);
      const span = grid.spans.get(`${r}:${c}`);
      cells.push(span && span > 1 ? { text: t, span: Math.min(span, last - c + 1) } : { text: t });
    }
    const kind = r === headerRow || r === upperHeader ? 'HEADER' : rowKinds.get(r) ?? (detailRows.has(r) ? 'DETAIL' : 'OTHER');
    rows.push({ row: r + 1, cells, kind });
  }
  return { firstColumn: first + 1, rows, truncated: end - start > rows.length && rows.length >= PREVIEW_ROWS };
}

// ── Against the order ───────────────────────────────────────────────────────

export interface PackingMatch {
  /** Each colour the document names → the order's colour it is, or null. */
  colours: Record<string, string | null>;
  /** Each carton row's order colour, in the order of `cartons`: a style column can tell apart one colour in two styles. */
  cartonColours: Array<string | null>;
  /** For a row left unmatched: how many of the order's colours it could be (0 = none, 2+ = several styles share it). */
  cartonColourCandidates: number[];
  /** Each size the document names → the order's size it is, or null. */
  sizes: Record<string, string | null>;
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** "wh", "wht" and "whi" all shorten "white": same first letter, the rest in order. */
function abbreviates(short: string, long: string): boolean {
  if (short.length > long.length || short[0] !== long[0]) return false;
  let k = 0;
  for (const ch of long) if (ch === short[k]) k++;
  return k === short.length;
}

/**
 * Which order colour a document's colour is.
 *
 * Exact (ignoring case and punctuation) first; then word by word, each word of
 * one a prefix of the other's — a packing list abbreviates, "COLUMBIA/WH" is
 * "Columbia/White". Only a single candidate counts: two would be a guess.
 */
export function matchColour(name: string, orderColours: readonly string[], style?: string | null): string | null {
  const key = words(name).join(' ');
  if (!key) return null;
  const a = words(name);
  const same = (x: string) => words(x).join(' ') === key;
  const near = (x: string) => {
    const b = words(x);
    return b.length === a.length && a.every((w, i) => abbreviates(w, b[i]!) || abbreviates(b[i]!, w));
  };
  // An order holding a whole buy names its colours "STYLE — COLOUR"; the
  // packing list names the colour, and the style in a column of its own.
  const part = (c: string) => c.split(/\s+[—–-]\s+/).pop()!;
  const styleOf = (c: string) => (c.includes(' — ') || / [–-] /.test(c) ? c.split(/\s+[—–-]\s+/)[0]! : '');
  const byStyle = (list: string[]) => {
    if (list.length <= 1 || !style) return list;
    const s = words(style).join(' ');
    const hit = list.filter((c) => { const t = words(styleOf(c)).join(' '); return t !== '' && (t.includes(s) || s.includes(t)); });
    return hit.length > 0 ? hit : list;
  };
  for (const test of [
    (c: string) => same(c), (c: string) => same(part(c)), (c: string) => near(c), (c: string) => near(part(c)),
  ]) {
    const found = byStyle(orderColours.filter(test));
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return null;
  }
  return null;
}

export function matchPackingToOrder(
  layout: Pick<PackingLayout, 'cartons' | 'table'>,
  order: { colours: readonly string[]; sizes: readonly string[] },
  sizeAlias: (labels: readonly string[], orderSizes: readonly string[]) => Record<string, string>,
): PackingMatch {
  const colours: Record<string, string | null> = {};
  const cartonColours = layout.cartons.map((c) => (c.colour ? matchColour(c.colour, order.colours, c.style) : null));
  layout.cartons.forEach((c, i) => {
    if (!c.colour) return;
    // One name for the colour when every row of it went to the same order colour.
    if (!(c.colour in colours)) colours[c.colour] = cartonColours[i]!;
    else if (colours[c.colour] !== cartonColours[i]) colours[c.colour] = cartonColours[i] ?? colours[c.colour] ?? null;
  });
  const labels = layout.table?.sizes ?? [];
  const alias = sizeAlias(labels, order.sizes);
  const sizes: Record<string, string | null> = {};
  for (const l of labels) {
    const exact = order.sizes.find((s) => s.trim().toLowerCase() === l.trim().toLowerCase());
    sizes[l] = exact ?? alias[l] ?? null;
  }
  const cartonColourCandidates = layout.cartons.map((c, i) => {
    if (!c.colour || cartonColours[i]) return cartonColours[i] ? 1 : 0;
    const key = words(c.colour).join(' ');
    return order.colours.filter((o) => words(o.split(/\s+[—–-]\s+/).pop()!).join(' ') === key || words(o).join(' ') === key
      || (() => { const a = words(c.colour!); const b = words(o.split(/\s+[—–-]\s+/).pop()!); return b.length === a.length && a.every((w, k) => abbreviates(w, b[k]!) || abbreviates(b[k]!, w)); })()).length;
  });
  return { colours, cartonColours, cartonColourCandidates, sizes };
}
