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
import { evaluateCell } from './formula-eval.js';
import { readPdf, groupIntoRows, rowToPositionedCells, findTableBands, type PdfPage } from './pdf-extractor.js';
import { BadRequestError } from '../../errors.js';
import { orderSizes as wearingOrder } from './po-lines.js';
import { parseAmount } from './size-grid.js';
import { isTotalsLabel } from './row-labels.js';

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
  /**
   * More of the carton above, in another colour. A mixed carton on the
   * factory sheet runs over several rows, each naming its own colour; it is
   * one carton, so this part adds pieces but not a carton.
   */
  continues?: boolean;
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
  /** Cells holding a formula that could not be worked out, keyed "row:col" (0-based). */
  unknown?: Set<string>;
  /** Those cells' addresses and formulas, by the same key — so a warning can name them. */
  unknownFormulas?: Map<string, string>;
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
  const unknown = new Set<string>();
  const unknownFormulas = new Map<string, string>();
  let uncached = 0;
  const lastRow = Math.min(ws.rowCount, MAX_ROWS);
  const lastCol = Math.min(ws.columnCount, MAX_COLS);
  for (let r = 1; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const out: Cell[] = [];
    for (let c = 1; c <= lastCol; c++) {
      const cell = row.getCell(c);
      if (cell.isMerged && cell.master !== cell) { out.push(null); continue; }
      if (isUncachedFormula(cell.value)) {
        // Saved without its result: worked out here when it is plain
        // arithmetic, and only counted as unreadable when it is not.
        const e = evaluateCell(ws, cell);
        if (!e) {
          uncached++;
          unknown.add(`${r - 1}:${c - 1}`);
          const f = (cell as unknown as { formula?: string }).formula;
          unknownFormulas.set(`${r - 1}:${c - 1}`, `${cell.address}${f ? ` =${f.length > 60 ? `${f.slice(0, 57)}…` : f}` : ''}`);
          out.push(null);
          continue;
        }
        out.push(typeof e.value === 'string' ? (e.value.trim() || null) : e.value);
        continue;
      }
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
  return { name: ws.name, rows, spans, uncached, unknown, unknownFormulas };
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

/** "1,200", "12.5", and the European "12,5" and "1.234,5" — a number as printed, by where its comma sits. */
const PRINTED_NUMBER = /^-?[\d,]+(\.\d+)?$|^-?(\d{1,3}(\.\d{3})*|\d+),\d{1,2}$/;

function pdfValue(t: string): Cell {
  const s = t.trim();
  if (s === '') return null;
  // "12,5" kg is twelve and a half: stripping the comma read it as 125.
  const n = PRINTED_NUMBER.test(s) ? parseAmount(s) : null;
  return n != null ? n : s;
}

// ── Reading the cells ───────────────────────────────────────────────────────

const text = (c: Cell): string => (c == null ? '' : String(c).trim());

function num(c: Cell): number | null {
  if (c == null) return null;
  if (typeof c === 'number') return c;
  const s = c.replace(/\s*(kgs?|pcs|pieces|pc|ctns?|cartons?)\.?\s*$/i, '').trim();
  if (!PRINTED_NUMBER.test(s)) return null;
  return parseAmount(s);
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
  // "Discription" is how the factory's own proforma spells it.
  if (/^(style|style ?(no|#|name)|article|art ?no|item|item ?no|model|desc|description|discription|discreption|descripton)$/.test(h)) return 'STYLE';
  if (/^(po|po ?(no|#|number)|order ?(no|#))$/.test(h)) return 'PO';
  return null;
}

/** Labels of the title block that are known without a colon. */
const KNOWN_LABEL = /^(po|po ?(no|#|number)|po ?date|order ?(no|name|date)|invoice ?(no|#|date)|date|style ?(no|#)?|season|client|buyer|customer|consignee|shipper|exporter|notify ?party|destination|port ?of ?(loading|discharge)|vessel|container ?(no)?|seal ?(no)?|bl ?no|awb ?no|method ?of ?shipping|ship ?(via|mode|date)|shipping ?(date|method|mode)|(shipping|billing|delivery) ?ad+r?ess|no ?of ?(ctns?|cartons?)|total ?(ctns?|cartons?)|delivery ?date|required ?delivery ?date|prom+is+ed ?shipping ?date|coordinator|item ?type|gender|fabric|description|brand|country ?of ?origin|origin|terms|payment ?terms|incoterms?|price( ?in ?us)?|cut ?percentage|packing ?inst)$/;

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
  // Sizes headed by numbers — 28 30 32 34 36 38 40 — outnumber the words, so
  // a row that names at least two columns (Ctn No, Colour, Total) is still a heading.
  const named = nonEmpty.filter((c) => typeof c === 'string' && roleOf(c) != null).length;
  if (nonEmpty.filter((c) => typeof c === 'number').length > nonEmpty.length / 2 && named < 2) return null;
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

/**
 * A TOTAL row. "Total", "Grand Total", "TTL: 240 pcs" anywhere on the row; a
 * label that only starts with the word ("Total RED", a colour block's total)
 * counts too, except as the colour of a numbered carton — Nike's "Total
 * Orange" is a colour, and carton 2 in it was dropped and ended the list.
 */
const isTotalRow = (row: Cell[], colourCol?: number, numbered?: (row: Cell[]) => boolean): boolean =>
  row.some((c, i) => {
    if (typeof c !== 'string') return false;
    const t = c.trim();
    if (isTotalsLabel(t, { trailing: false })) return true;
    if (!/^(grand\s*|sub\s*-?\s*)?(total|totals|ttl|sum)\b\s*[:：]?/i.test(t)) return false;
    return !(i === colourCol && numbered?.(row));
  });

const isGrandTotal = (row: Cell[]): boolean =>
  row.some((c) => typeof c === 'string' && /^grand\s*total/i.test(c.trim()));

function readCartons(grid: Grid, header: HeaderPick, issues: PackingIssue[]) {
  const col = (role: PackingColumnRole) => header.columns.find((c) => c.role === role)?.index;
  const cNo = col('CARTON_NO'); const cFrom = col('CARTON_FROM'); const cTo = col('CARTON_TO');
  const cCount = col('CARTON_COUNT'); const cColour = col('COLOUR'); const cSize = col('SIZE');
  const cQty = col('QTY'); const cPer = col('PCS_PER_CARTON'); const cTotal = col('TOTAL');
  const cGross = col('GROSS'); const cNet = col('NET'); const cGrossT = col('GROSS_TOTAL'); const cNetT = col('NET_TOTAL');
  const cMeas = col('MEASUREMENT'); const cStyle = col('STYLE');
  const sizeCols = header.columns.filter((c) => c.role === 'SIZE_COLUMN');
  const numbered = cNo != null || cFrom != null;

  const shape: NonNullable<PackingLayout['table']>['shape'] = sizeCols.length >= 1 && cSize == null
    ? 'SIZES_ACROSS'
    : cSize != null ? 'ROW_PER_SIZE' : 'ROW_PER_CARTON';

  /** The carton number(s) a row gives, as written and as a range. */
  const numberOf = (row: Cell[]): { text: string; range: [number, number] | null } => {
    const at = (i: number | undefined): Cell => (i == null ? null : row[i] ?? null);
    if (cFrom != null && num(at(cFrom)) != null) {
      const a = num(at(cFrom))!; const b = num(at(cTo)) ?? a;
      const range: [number, number] = b >= a ? [a, b] : [a, a];
      return { text: a === range[1] ? String(a) : `${a}-${range[1]}`, range };
    }
    if (cNo != null && at(cNo) != null) {
      const t = displayValue(at(cNo)).replace(/,/g, '');
      return { text: t, range: cartonRange(t) };
    }
    return { text: '', range: null };
  };
  /** The row names a carton (so a "Total …" in its colour column is a colour). */
  const hasNumber = (row: Cell[]): boolean => numberOf(row).range != null;
  // A second header repeated further down (a page break in a PDF).
  const isRepeatedHeader = (row: Cell[]): boolean =>
    header.columns.filter((c) => c.role !== 'OTHER' && typeof row[c.index] === 'string' && roleOf(text(row[c.index] ?? null)) === c.role).length >= 2;
  const isBlank = (row: Cell[]): boolean => !header.columns.some((c) => (row[c.index] ?? null) != null);

  const cartons: PackingCarton[] = [];
  const rowKinds = new Map<number, 'CARTON' | 'TOTAL'>();
  let blankRun = 0;
  let lastColour: string | null = null;
  let lastStyle: string | null = null;
  let unreadable = 0;
  /** Something other than a carton (a total, an unread row) came since the last carton row. */
  let gap = false;
  const fractional: number[] = [];
  /** A carton count written beside a carton range that does not agree with it. */
  const countDiffers: Array<{ row: number; number: string; count: number }> = [];
  /** Rows whose colour is a formula that could not be worked out, and their pieces. */
  const noColour: Array<{ row: number; pieces: number }> = [];
  /** Rows read as a whole run and split per carton — undone below if the TOTAL row says otherwise. */
  const split: Array<{ index: number; count: number }> = [];
  /** Rows read as per carton that could be the whole run — divided below if the TOTAL row says so. */
  const perRun: Array<{ index: number; count: number }> = [];
  type Printed = NonNullable<PackingLayout['printedTotals']>;
  /** TOTAL rows with more cartons after them: a sub-total per block. */
  const subTotals: Printed[] = [];
  /** The TOTAL rows the table ends on (a "Total" then a "Grand total"). */
  const endTotals: Array<Printed & { grand: boolean }> = [];

  const readTotal = (row: Cell[], r: number): Printed => {
    const at = (i: number | undefined): Cell => (i == null ? null : row[i] ?? null);
    const sumSizes = sizeCols.reduce((a, c) => a + (num(at(c.index)) ?? 0), 0);
    // A PDF's total line is often too short to sit under the table's
    // columns; its one number is then the pieces.
    const loose = row.map(num).filter((n): n is number => n != null);
    return {
      pieces: num(at(cTotal)) ?? num(at(cQty)) ?? (sumSizes > 0 ? sumSizes : null) ?? (loose.length === 1 ? loose[0]! : null),
      cartons: num(at(cCount)) ?? null,
      grossKg: num(at(cGrossT)) ?? num(at(cGross)),
      netKg: num(at(cNetT)) ?? num(at(cNet)),
      sheetRow: r + 1,
    };
  };

  for (let r = header.row + 1; r < grid.rows.length; r++) {
    const row = grid.rows[r] ?? [];
    const at = (i: number | undefined): Cell => (i == null ? null : row[i] ?? null);
    if (isBlank(row)) {
      if (++blankRun >= 3 && cartons.length > 0) break;
      continue;
    }
    blankRun = 0;

    if (isTotalRow(row, cColour, hasNumber)) {
      // A TOTAL row ends the table — unless more numbered cartons follow it:
      // then it was the total of one block (one colour, one style), and the
      // reading goes on. Stopped at the first, every block after it was lost.
      rowKinds.set(r, 'TOTAL');
      gap = true;
      const t = readTotal(row, r);
      let k = r + 1;
      let blanks = 0;
      const run: Array<Printed & { grand: boolean }> = [{ ...t, grand: isGrandTotal(row) }];
      for (; k < grid.rows.length; k++) {
        const next = grid.rows[k] ?? [];
        if (isBlank(next)) { if (++blanks >= 3) break; continue; }
        blanks = 0;
        if (isRepeatedHeader(next)) continue;
        if (isTotalRow(next, cColour, hasNumber)) { run.push({ ...readTotal(next, k), grand: isGrandTotal(next) }); rowKinds.set(k, 'TOTAL'); continue; }
        break;
      }
      const resumes = numbered && k < grid.rows.length && blanks < 3 && numberOf(grid.rows[k] ?? []).range != null;
      if (resumes) { subTotals.push(...run.map(({ grand: _g, ...p }) => p)); r = k - 1; continue; }
      endTotals.push(...run);
      break;
    }
    if (isRepeatedHeader(row)) continue;

    // The carton number(s).
    const { text: numberText, range } = numberOf(row);
    const countCell = num(at(cCount));
    // A carton count is taken as written. A proforma estimates it — pieces ÷
    // pieces per carton, 9.1 — and rounding each line made the cartons stop
    // adding up to the document's own total.
    const count = countCell != null && countCell > 0 ? Math.round(countCell * 1000) / 1000 : range ? range[1] - range[0] + 1 : 1;
    if (!Number.isInteger(count)) fractional.push(r + 1);
    if (countCell != null && countCell > 0 && range && Math.abs(countCell - (range[1] - range[0] + 1)) > 0.001 && Number.isInteger(countCell)) {
      countDiffers.push({ row: r + 1, number: numberText, count: countCell });
    }

    const colourCell = text(at(cColour)) || null;
    // A colour that is a formula nobody calculated is unknown — not the colour
    // of the row above, which is what a blank colour cell means. Inherited,
    // the PURPLE and WHITE rows of a packing list were counted as HUNTER,
    // LIME and ORANGE.
    const colourUnknown = !colourCell && cColour != null && (grid.unknown?.has(`${r}:${cColour}`) ?? false);
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
    /** How the pieces of a row with a carton run were read, to be checked against the TOTAL row. */
    let runReading: 'split' | 'perRun' | null = null;
    if (shape === 'ROW_PER_CARTON') {
      const per = num(at(cPer));
      const qtyCell = num(at(cQty));
      const qty = qtyCell ?? num(at(cTotal));
      if (per != null) perCarton = per;
      else if (qty == null) perCarton = 0;
      else if (count <= 1) perCarton = qty;
      // A line with no carton number but a carton count — a summary by style,
      // "1,092 pcs in 10 cartons" — gives the pieces of the whole line.
      else if (!numbered) perCarton = qty / count;
      // "From 1 To 10 | Total 240": a Total is the whole run, 24 a carton —
      // read as one carton's, the run showed 2,400 pcs. When it does not
      // divide evenly it cannot be the run of identical cartons.
      else if (qtyCell == null && qty % count === 0) { perCarton = qty / count; runReading = 'split'; }
      // A "Qty" beside a run is usually one carton's; the TOTAL row decides below.
      else { perCarton = qty; if (qty % count === 0) runReading = 'perRun'; }
    }

    const head = [...cartons].reverse().find((c) => !c.continues) ?? null;
    // More of the carton above: a row with no carton number (the factory
    // sheet numbers only the first row of a mixed carton, and a merged
    // number leaves the rows under it blank), or the same number written
    // again on the very next row (a list that repeats "1-10" on every size).
    // Counted as new cartons, a 10-carton run became 30 cartons.
    const continuesAbove = cartons.length > 0 && perCarton > 0 && (
      (!numberText && (shape === 'ROW_PER_SIZE' || (numbered && countCell == null)))
      || (!gap && numberText !== '' && head != null && head.number === numberText && (countCell == null || countCell === head.count)));
    if (continuesAbove) {
      const prev = cartons[cartons.length - 1]!;
      gap = false;
      // Each row of a mixed carton names its own colour. Folded into the
      // carton's first colour, a HUNTER/WHT carton holding LIME/BLACK too
      // counted every piece as HUNTER/WHT.
      if (colourUnknown || (colourCell && (prev.colour ?? '').trim().toUpperCase() !== colourCell.trim().toUpperCase())) {
        if (colourUnknown) noColour.push({ row: r + 1, pieces: perCarton * prev.count });
        cartons.push({
          number: prev.number, count: prev.count, colour: colourUnknown ? null : colourCell, style: styleCell ?? prev.style,
          bySize: { ...bySize }, perCarton, totalPieces: perCarton * prev.count,
          grossKg: null, netKg: null, measurement: null, sheetRow: r + 1, lastRow: r + 1, continues: true,
        });
        // A weight written on a later row is the carton's.
        if (head && head.grossKg == null) head.grossKg = num(at(cGross));
        if (head && head.netKg == null) head.netKg = num(at(cNet));
        rowKinds.set(r, 'CARTON');
        continue;
      }
      for (const [s, n] of Object.entries(bySize)) prev.bySize[s] = (prev.bySize[s] ?? 0) + n;
      prev.perCarton += perCarton;
      prev.totalPieces = prev.perCarton * prev.count;
      prev.lastRow = r + 1;
      if (head && head.grossKg == null) head.grossKg = num(at(cGross));
      if (head && head.netKg == null) head.netKg = num(at(cNet));
      rowKinds.set(r, 'CARTON');
      continue;
    }
    if (!numberText && perCarton === 0 && countCell == null) {
      if (cartons.length > 0) { unreadable++; gap = true; }
      continue;
    }

    const colour = colourUnknown ? null : colourCell ?? lastColour;
    if (colourUnknown) noColour.push({ row: r + 1, pieces: perCarton * count });
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
      runReading = 'split';
    }
    if (runReading === 'split') split.push({ index: cartons.length, count });
    if (runReading === 'perRun') perRun.push({ index: cartons.length, count });

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
    gap = false;

    if (printedTotal != null && cTotal != null && shape !== 'ROW_PER_SIZE' && Math.abs(printedTotal - perCarton * count) > 0.001 && Math.abs(printedTotal - perCarton) > 0.001) {
      issues.push({ level: 'WARNING', message: `Row ${r + 1}: the row's total says ${printedTotal.toLocaleString('en-US')} pcs, but ${count} carton${count === 1 ? '' : 's'} × ${perCarton.toLocaleString('en-US')} pcs is ${(perCarton * count).toLocaleString('en-US')}.` });
    }
  }

  // Which TOTAL row the cartons answer to. Of the rows the table ends on, a
  // "Grand total" first; with blocks, the sum of the blocks' totals when the
  // last one is only its block's.
  const pieces = () => cartons.reduce((a, c) => a + c.totalPieces, 0);
  let printed: PackingLayout['printedTotals'] = null;
  if (endTotals.length > 0 || subTotals.length > 0) {
    const sum = (list: Printed[]): Printed => {
      const add = (k: 'pieces' | 'cartons' | 'grossKg' | 'netKg') =>
        list.every((t) => t[k] == null) ? null : list.reduce((a, t) => a + (t[k] ?? 0), 0);
      return { pieces: add('pieces'), cartons: add('cartons'), grossKg: add('grossKg'), netKg: add('netKg'), sheetRow: list[list.length - 1]!.sheetRow };
    };
    const strip = ({ grand: _g, ...p }: Printed & { grand: boolean }): Printed => p;
    const grand = endTotals.find((t) => t.grand);
    const last = endTotals[0];
    const candidates: Printed[] = [];
    if (grand) candidates.push(strip(grand));
    if (last) candidates.push(strip(last));
    // A block's own total, then the next block's: the sum of them.
    const blocks = [...subTotals, ...(last && !last.grand ? [strip(last)] : [])];
    if (subTotals.length > 0) candidates.push(sum(blocks));
    // Undo or apply a run's split first, so the choice sees the final pieces.
    for (const c of candidates) if (c.pieces != null && settleRuns(c.pieces)) break;
    const read = pieces();
    printed = candidates.find((c) => c.pieces != null && Math.abs(c.pieces - read) < 0.5) ?? candidates[0] ?? null;
  }

  /**
   * A Total column can be per carton as easily as per run. Where rows with a
   * carton run could be read either way, the document's own TOTAL row decides.
   */
  function settleRuns(target: number): boolean {
    const asRead = pieces();
    if (Math.abs(asRead - target) < 0.5) return true;
    const unsplit = asRead + split.reduce((a, sp) => a + cartons[sp.index]!.totalPieces * (sp.count - 1), 0);
    if (split.length > 0 && Math.abs(unsplit - target) < 0.5) {
      for (const sp of split) scale(cartons[sp.index]!, sp.count);
      return true;
    }
    const divided = asRead - perRun.reduce((a, pr) => a + cartons[pr.index]!.totalPieces * (1 - 1 / pr.count), 0);
    if (perRun.length > 0 && Math.abs(divided - target) < 0.5) {
      for (const pr of perRun) scale(cartons[pr.index]!, 1 / pr.count);
      return true;
    }
    return false;
  }
  function scale(c: PackingCarton, by: number) {
    for (const k of Object.keys(c.bySize)) c.bySize[k] = c.bySize[k]! * by;
    c.perCarton *= by;
    c.totalPieces = c.perCarton * c.count;
  }

  if (noColour.length > 0) {
    const pcs = noColour.reduce((a, n) => a + n.pieces, 0);
    issues.push({
      level: 'WARNING',
      message: `Row${noColour.length === 1 ? '' : 's'} ${noColour.slice(0, 8).map((n) => n.row).join(', ')}${noColour.length > 8 ? '…' : ''}: the colour is a formula Excel never calculated, `
        + `so ${pcs.toLocaleString('en-US')} pcs are shown with no colour rather than under the colour above. Open the file in Excel, save it, and attach it again.`,
    });
  }
  if (fractional.length > 0) {
    issues.push({
      level: 'INFO',
      message: `The carton count on ${fractional.length === 1 ? `row ${fractional[0]} is` : `${fractional.length} rows is`} not a whole number: `
        + 'the document works it out from pieces ÷ pieces per carton. It is shown as written, so the cartons add up to the document\'s own total.',
    });
  }
  for (const d of countDiffers.slice(0, 5)) {
    issues.push({ level: 'WARNING', message: `Row ${d.row}: cartons ${d.number} is ${cartonRange(d.number) ? cartonRange(d.number)![1] - cartonRange(d.number)![0] + 1 : '?'} cartons, but the row says ${d.count}. The row's ${d.count} is used.` });
  }
  if (unreadable > 0) {
    issues.push({ level: 'WARNING', message: `${unreadable} row${unreadable === 1 ? '' : 's'} under the table had neither a carton number nor pieces, and ${unreadable === 1 ? 'was' : 'were'} not read.` });
  }
  // A numbered carton with no pieces in it, all its colours counted: kept, so
  // the count of boxes is right, and said.
  cartons.forEach((c, i) => {
    if (c.continues || !c.number) return;
    let pcs = c.perCarton;
    for (let k = i + 1; k < cartons.length && cartons[k]!.continues; k++) pcs += cartons[k]!.perCarton;
    if (pcs === 0) issues.push({ level: 'WARNING', message: `Row ${c.sheetRow}: carton ${c.number} has no pieces in it.` });
  });
  // Carton numbers that overlap — 1-10 then 8-15 — count the same boxes twice.
  const runs = cartons.filter((c) => !c.continues && c.number).map((c) => ({ c, range: cartonRange(c.number) }))
    .filter((x): x is { c: PackingCarton; range: [number, number] } => x.range != null)
    .sort((a, b) => a.range[0] - b.range[0]);
  const overlaps: string[] = [];
  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1]!; const b = runs[i]!;
    if (b.range[0] <= a.range[1] && a.c.number !== b.c.number) overlaps.push(`${a.c.number} and ${b.c.number}`);
  }
  if (overlaps.length > 0) {
    issues.push({ level: 'WARNING', message: `Carton numbers overlap: ${overlaps.slice(0, 4).join('; ')}${overlaps.length > 4 ? '…' : ''}. The same boxes may be counted twice.` });
  }
  if (runs.length > 1 && runs.length === cartons.filter((c) => !c.continues).length) {
    const missing: string[] = [];
    let expect = runs[0]!.range[0];
    for (const x of runs) {
      if (x.range[0] > expect) missing.push(x.range[0] - 1 === expect ? String(expect) : `${expect}-${x.range[0] - 1}`);
      expect = Math.max(expect, x.range[1] + 1);
    }
    if (missing.length > 0) {
      issues.push({ level: 'INFO', message: `No carton${missing.length === 1 && !missing[0]!.includes('-') ? '' : 's'} ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''} in the list, between ${runs[0]!.range[0]} and ${expect - 1}.` });
    }
  }
  // Pieces per carton from a division carry float noise (120.00000000000001).
  for (const c of cartons) { c.perCarton = Math.round(c.perCarton * 1000) / 1000; c.totalPieces = Math.round(c.totalPieces * 1000) / 1000; }
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
      // "PO No: 12345" in one cell — unless the cell is the value of the
      // label to its left: "No. of cartons | 289 carton NW: … KG." is one
      // detail, not a detail named "289 carton NW".
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
    // Sizes as they are worn — YXS, YS, YM, YL, S, M, L — not in the order the
    // rows first happened to mention them (YXS, YL, YS, YM).
    table = { headerRow: header.row + 1, shape: read.shape, columns: header.columns, sizes: read.sizes ? sizesSeen : wearingOrder(sizesSeen) };
  } else {
    issues.push({ level: 'WARNING', message: 'No carton table was found: no row has a carton column (C/No, Ctn No, From/To or No. of cartons) next to pieces or sizes. The document is shown as it is.' });
  }

  const { details, titles, detailRows } = readDetails(grid, header ? header.row - (header.twoRow ? 1 : 0) : Math.min(grid.rows.length, 40));

  const totals = totalsOf(cartons);

  if (printed) {
    const differs = (a: number | null, b: number | null, tol: number) => a != null && b != null && Math.abs(a - b) > tol;
    // A TOTAL row of nothing beside cartons that hold pieces is a total the
    // sheet never filled in (or a formula never calculated) — said as that,
    // not as a disagreement.
    if (printed.pieces === 0 && totals.pieces > 0) {
      issues.push({ level: 'INFO', message: `The document's TOTAL row is empty or 0 — its total was not filled in or not calculated. The cartons add up to ${totals.pieces.toLocaleString('en-US')} pcs.` });
      printed.pieces = null;
    } else if (differs(printed.pieces, totals.pieces, 0.5)) issues.push({ level: 'WARNING', message: `The document's TOTAL row says ${printed.pieces!.toLocaleString('en-US')} pcs, but its cartons add up to ${totals.pieces.toLocaleString('en-US')}.` });
    if (differs(printed.cartons, totals.cartons, 0.5)) issues.push({ level: 'WARNING', message: `The document's TOTAL row says ${printed.cartons} cartons, but ${totals.cartons} were read.` });
    if (differs(printed.grossKg, totals.grossKg, 0.6)) issues.push({ level: 'WARNING', message: `The document's TOTAL row says ${printed.grossKg} kg gross, but the cartons add up to ${totals.grossKg} kg.` });
    if (differs(printed.netKg, totals.netKg, 0.6)) issues.push({ level: 'WARNING', message: `The document's TOTAL row says ${printed.netKg} kg net, but the cartons add up to ${totals.netKg} kg.` });
  }
  const heavy = cartons.filter((c) => c.grossKg != null && c.netKg != null && c.netKg > c.grossKg);
  if (heavy.length > 0) issues.push({ level: 'WARNING', message: `Net weight is more than gross weight on carton${heavy.length === 1 ? '' : 's'} ${heavy.slice(0, 5).map((c) => c.number).join(', ')}.` });
  const numbers = new Map<string, number>();
  for (const c of cartons) if (c.number && !c.continues) numbers.set(c.number.toUpperCase(), (numbers.get(c.number.toUpperCase()) ?? 0) + 1);
  const repeated = [...numbers.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (repeated.length > 0) issues.push({ level: 'WARNING', message: `Carton number${repeated.length === 1 ? '' : 's'} ${repeated.slice(0, 5).join(', ')} appear${repeated.length === 1 ? 's' : ''} more than once.` });
  if (grid.uncached > 0) {
    // Which formulas, and whether they touch the cartons. A formula in the
    // title block or beside the table (a sheet name, a running total) changes
    // nothing above, and telling the user to re-save the file for it sent
    // them back to Excel for no reason.
    const keys = [...(grid.unknown ?? [])];
    const inTable = keys.filter((k) => rowKinds.has(Number(k.split(':')[0])));
    const name = (k: string) => grid.unknownFormulas?.get(k) ?? k;
    const list = (ks: string[]) => ks.slice(0, 6).map(name).join('; ') + (ks.length > 6 ? `; and ${ks.length - 6} more` : '');
    if (inTable.length === 0) {
      issues.push({
        level: 'INFO',
        message: `${keys.length} formula${keys.length === 1 ? '' : 's'} in the sheet could not be calculated (${list(keys)}). `
          + `${keys.length === 1 ? 'It is' : 'They are'} outside the carton table, so the cartons above are read in full.`,
      });
    } else {
      issues.push({
        level: 'WARNING',
        message: `${inTable.length} cell${inTable.length === 1 ? '' : 's'} in the carton table ${inTable.length === 1 ? 'is a formula' : 'are formulas'} that could not be calculated, `
          + `so ${inTable.length === 1 ? 'it reads' : 'they read'} as empty: ${list(inTable)}. The rest of the table is read as it is.`
          + (keys.length > inTable.length ? ` (${keys.length - inTable.length} more outside the table don't affect it.)` : ''),
      });
    }
  }
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

/** What the cartons add up to: a colour continuing a mixed carton is more pieces, not another carton. */
export function totalsOf(cartons: readonly PackingCarton[]): PackingTotals {
  const totals: PackingTotals = { cartons: 0, pieces: 0, grossKg: null, netKg: null, bySize: {}, byColour: {} };
  for (const c of cartons) {
    if (!c.continues) totals.cartons += c.count;
    totals.pieces += c.totalPieces;
    if (c.grossKg != null) totals.grossKg = (totals.grossKg ?? 0) + c.grossKg * c.count;
    if (c.netKg != null) totals.netKg = (totals.netKg ?? 0) + c.netKg * c.count;
    for (const [s, n] of Object.entries(c.bySize)) totals.bySize[s] = (totals.bySize[s] ?? 0) + n * c.count;
    const k = c.colour ?? '—';
    totals.byColour[k] = (totals.byColour[k] ?? 0) + c.totalPieces;
  }
  const round = (n: number | null) => (n == null ? null : Math.round(n * 1000) / 1000);
  totals.grossKg = round(totals.grossKg); totals.netKg = round(totals.netKg);
  totals.pieces = Math.round(totals.pieces * 1000) / 1000;
  return totals;
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
