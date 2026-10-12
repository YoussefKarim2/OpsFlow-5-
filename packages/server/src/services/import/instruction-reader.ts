/**
 * Reading a special-instructions spreadsheet into instruction drafts.
 *
 * Customers and coordinators send these in three shapes, often mixed:
 *
 *  - a names-and-numbers list for printing: Name / No. / Size / Qty;
 *  - a list of instructions, one per row, sometimes with a department column;
 *  - free text typed into cells — the factory workbook's own
 *    "Custom Instructions_Coordinator" sheet is this, under a header block of
 *    formulas copied from Order Details.
 *
 * Columns are recognised by their headings in English or Arabic, wherever the
 * heading row sits. Formula cells are never read as instructions: in these
 * workbooks they are copies of other sheets (PO number, season, client).
 * Departments are taken from a department column when there is one, and
 * otherwise inferred from what the text is about (printing, packing, cutting…).
 *
 * Nothing here saves anything: the drafts go to the review screen first.
 * Pure functions over cell grids, plus one wrapper that opens the file.
 */

import type ExcelJS from 'exceljs';
import { openWorkbook, readCsvWorkbook } from './open-workbook.js';
import { detectFileKind } from './file-kind.js';
import { BadRequestError } from '../../errors.js';

export type Department =
  | 'COORDINATOR' | 'FACTORY_MANAGER' | 'PRODUCTION_MANAGER' | 'CUTTING_MARKER' | 'WAREHOUSE'
  | 'EXTERNAL_OPS' | 'PACKING' | 'QUALITY' | 'FOLLOW_UP' | 'FINANCE';

export interface InstructionLineDraft {
  name: string | null; number: string | null; sizeLabel: string | null; qty: number | null; note: string | null;
}
export interface InstructionDraft {
  title: string;
  body: string;
  visibleTo: Department[];
  lines: InstructionLineDraft[];
  /** Where it was read from, for the review screen. */
  source: string;
}

/** One cell as read: its text, and whether it was a formula (a copy of another sheet). */
export interface GridCellIn { text: string; formula: boolean }
export interface SheetIn { name: string; rows: GridCellIn[][] }

// ── Headings ────────────────────────────────────────────────────────────────

type Col = 'name' | 'number' | 'size' | 'qty' | 'note' | 'title' | 'instruction' | 'department';

const HEADINGS: Record<Col, RegExp> = {
  name: /^(name|names|player|player\s*name|players?|surname|last\s*name|back\s*name|name\s*on\s*back|printed\s*name|name\s*to\s*print|الاسم|اسم|اسم\s*اللاعب)$/i,
  number: /^(no\.?|#|nr\.?|num|number|numbers|shirt\s*(no\.?|number)|player\s*(no\.?|number)|jersey\s*(no\.?|number)|back\s*number|الرقم|رقم)$/i,
  size: /^(size|sizes|sz|taille|المقاس|مقاس)$/i,
  qty: /^(qty|qty\.|quantity|pcs|pieces|units|amount|العدد|الكمية|كمية)$/i,
  note: /^(note|notes|remark|remarks|comment|comments|ملاحظات|ملاحظة)$/i,
  title: /^(title|subject|topic|item|point|heading|العنوان|البند)$/i,
  instruction: /^(instructions?|special\s*instructions?|custom\s*instructions?|description|details?|requirements?|text|instruction\s*details|التعليمات|تعليمات|الوصف|التفاصيل)$/i,
  department: /^(department|dept\.?|departments|for|responsible|owner|team|read\s*by|القسم|الإدارة|المسؤول)$/i,
};

const clean = (s: string) => s.replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim();

function headingOf(text: string): Col | null {
  const t = clean(text);
  for (const [col, re] of Object.entries(HEADINGS) as Array<[Col, RegExp]>) if (re.test(t)) return col;
  return null;
}

/** The first row, in the top thirty, that names two or more known columns. */
function findHeader(rows: GridCellIn[][]): { index: number; cols: Partial<Record<Col, number>> } | null {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cols: Partial<Record<Col, number>> = {};
    rows[r]!.forEach((c, i) => {
      if (c.formula) return;
      const h = headingOf(c.text);
      if (h && cols[h] == null) cols[h] = i;
    });
    const found = Object.keys(cols).length;
    const isNames = cols.name != null || cols.number != null;
    const isList = cols.instruction != null;
    if (found >= 2 && (isNames || isList)) return { index: r, cols };
    if (isList && found >= 1) return { index: r, cols };
  }
  return null;
}

// ── Departments ─────────────────────────────────────────────────────────────

const DEPARTMENT_WORDS: Array<[Department, RegExp]> = [
  ['EXTERNAL_OPS', /\b(print\w*|screen\s*print|sublimat\w*|heat\s*(press|transfer)|embroider\w*|emb\.?|patch(es)?|badge|logo)\b|طباعة|تطريز|شعار/i],
  ['PACKING', /\b(pack\w*|fold\w*|poly\s*bag|polybag|carton|box(es)?|hang\s*tag|barcode|sticker)\b|تعبئة|تغليف|كرتون|باكينج/i],
  ['CUTTING_MARKER', /\b(cut|cutting|marker|lay(ing)?|spread\w*|grain|shade)\b|قص|ماركر|فرش/i],
  ['PRODUCTION_MANAGER', /\b(sew\w*|stitch\w*|seam\w*|hem\w*|neck\s*tape|overlock|cover\s*stitch|label\w*|collar|sleeve)\b|خياطة|حياكة|ليبل/i],
  ['QUALITY', /\b(quality|qc|aql|inspect\w*|measure\w*|tolerance)\b|جودة|فحص/i],
  ['WAREHOUSE', /\b(fabric\s*(roll|stock)|trims?|accessor\w*|warehouse)\b|مخزن|اكسسوار/i],
  ['FINANCE', /\b(invoice|payment|price|cost)\b|فاتورة|دفع/i],
];

const DEPARTMENT_NAMES: Array<[Department, RegExp]> = [
  ['COORDINATOR', /coordinat|منسق/i],
  ['FACTORY_MANAGER', /factory\s*manag|مدير\s*المصنع/i],
  ['PRODUCTION_MANAGER', /production|sewing|line|انتاج|إنتاج/i],
  ['CUTTING_MARKER', /cut|marker|قص/i],
  ['WAREHOUSE', /warehouse|store|مخزن/i],
  ['EXTERNAL_OPS', /external|print|embroid|outside|خارجي|طباعة|تطريز/i],
  ['PACKING', /pack|تعبئة|تغليف/i],
  ['QUALITY', /quality|qc|جودة/i],
  ['FOLLOW_UP', /follow/i],
  ['FINANCE', /financ|account|مالية|حسابات/i],
];

/** Departments named in a cell ("Packing, QC"). */
function departmentsNamed(text: string): Department[] {
  const out: Department[] = [];
  for (const part of text.split(/[,;/&+]|\band\b|،/i)) {
    const hit = DEPARTMENT_NAMES.find(([, re]) => re.test(part));
    if (hit && !out.includes(hit[0])) out.push(hit[0]);
  }
  return out;
}

/** Departments the text is about. Always at least the coordinator and production. */
export function inferDepartments(text: string, hasNames = false): Department[] {
  const out: Department[] = [];
  for (const [d, re] of DEPARTMENT_WORDS) if (re.test(text)) out.push(d);
  // A names-and-numbers list is printed outside and packed per player.
  if (hasNames) for (const d of ['EXTERNAL_OPS', 'PACKING'] as const) if (!out.includes(d)) out.push(d);
  for (const d of ['COORDINATOR', 'PRODUCTION_MANAGER'] as const) if (!out.includes(d)) out.push(d);
  return out;
}

// ── Sheets ──────────────────────────────────────────────────────────────────

const FOOTER = /^(approved|prepared\s*by|checked\s*by|signature|sign|date|a\.?\s*s\.?|إعتماد|اعتماد|توقيع)$/i;
const TOTAL = /^(total|totals|grand\s*total|المجموع|الإجمالي)$/i;

const text = (row: GridCellIn[] | undefined, i: number | undefined) => (i == null || !row?.[i] ? '' : clean(row[i]!.text));

function asQty(s: string): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The text itself when it is short, otherwise its first words. */
function shortTitle(body: string): string {
  if (body.length <= 80) return body;
  const words = body.split(/\s+/);
  let out = '';
  for (const w of words) { if ((out + ' ' + w).trim().length > 70) break; out = (out + ' ' + w).trim(); }
  return `${out}…`;
}

/** "Florida 23 – names.xlsx" → "Florida 23 – names". */
const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

/** One sheet into drafts. */
export function readInstructionSheet(sheet: SheetIn, fileName: string): InstructionDraft[] {
  const rows = sheet.rows;
  const header = findHeader(rows);
  const used = new Set<number>(); // rows consumed by a table
  const drafts: InstructionDraft[] = [];
  const lines: InstructionLineDraft[] = [];

  if (header && (header.cols.name != null || header.cols.number != null) && header.cols.instruction == null) {
    used.add(header.index);
    let blanks = 0;
    for (let r = header.index + 1; r < rows.length; r++) {
      const row = rows[r]!;
      const line: InstructionLineDraft = {
        name: text(row, header.cols.name) || null,
        number: text(row, header.cols.number) || null,
        sizeLabel: text(row, header.cols.size) || null,
        qty: asQty(text(row, header.cols.qty)),
        note: text(row, header.cols.note) || null,
      };
      const first = clean(row.find((c) => c.text.trim())?.text ?? '');
      if (TOTAL.test(first)) { used.add(r); break; }
      // A sentence under the list, with no number beside it, is a note about
      // the list ("White vinyl, numbers 25 cm…"), not a player.
      if (line.name && !line.number && (line.name.split(/\s+/).length > 4 || line.name.length > 40)) break;
      if (!line.name && !line.number) {
        if (row.every((c) => !c.text.trim())) { if (++blanks >= 3) break; continue; }
        // A row with neither name nor number but other content ends the list.
        if (!line.sizeLabel && line.qty == null) break;
      }
      blanks = 0;
      used.add(r);
      if (line.name || line.number) lines.push(line);
    }
  }

  if (header && header.cols.instruction != null) {
    used.add(header.index);
    for (let r = header.index + 1; r < rows.length; r++) {
      const row = rows[r]!;
      const body = text(row, header.cols.instruction);
      if (!body) continue;
      used.add(r);
      const title = text(row, header.cols.title) || shortTitle(body);
      const named = departmentsNamed(text(row, header.cols.department));
      const extra = [text(row, header.cols.note)].filter(Boolean).join('\n');
      const full = extra ? `${body}\n${extra}` : body;
      drafts.push({
        title: title.slice(0, 200), body: full, source: `${fileName} › ${sheet.name}, row ${r + 1}`,
        visibleTo: named.length > 0 ? named : inferDepartments(`${title} ${full}`), lines: [],
      });
    }
  }

  // Free text: typed cells outside the tables, row by row. Formula cells are
  // copies of other sheets, merged cells repeat their value, and a signature
  // footer is not an instruction.
  const prose: string[] = [];
  rows.forEach((row, r) => {
    if (used.has(r)) return;
    // A row with a formula in it is the header block copied from Order
    // Details ("Po No : 89-39"); its typed labels are not instructions either.
    if (row.some((c) => c.formula)) return;
    const parts: string[] = [];
    for (const c of row) {
      if (c.formula) continue;
      const t = clean(c.text);
      if (!t || FOOTER.test(t) || parts[parts.length - 1] === t) continue;
      if (/^[\d.,\s-]+$/.test(t)) continue; // a stray number is not an instruction
      parts.push(t);
    }
    if (parts.length > 0) prose.push(parts.join(' – '));
  });
  // A sheet title on its own first line becomes the draft's title.
  // With a names list, a short line above it is the list's title even alone.
  const sheetTitle = (prose.length > 1 || (lines.length > 0 && prose.length === 1 && header != null && 0 < header.index))
    && prose[0]!.split(/\s+/).length <= 6 && !/[.!?:]$/.test(prose[0]!) ? prose.shift()! : null;

  if (lines.length > 0 || prose.length > 0) {
    const pieces = lines.reduce((a, l) => a + (l.qty ?? 1), 0);
    const body = prose.length > 0 ? prose.join('\n')
      : `Print the names and numbers below: ${lines.length} ${lines.length === 1 ? 'row' : 'rows'}, ${pieces} pcs.`;
    const title = sheetTitle
      ?? (lines.length > 0 ? 'Names and numbers' : prose.length > 0 ? shortTitle(prose[0]!) : baseName(fileName));
    drafts.unshift({
      title: title.slice(0, 200), body, lines, source: `${fileName} › ${sheet.name}`,
      visibleTo: inferDepartments(`${title} ${body}`, lines.length > 0),
    });
  }
  return drafts;
}

/** Every sheet worth reading, best first: a sheet named for instructions wins outright. */
export function readInstructionSheets(sheets: SheetIn[], fileName: string): InstructionDraft[] {
  // The factory workbook has a "Custom Instructions" sheet and a "Laying fabric
  // instructions" sheet; only the first is about this order's instructions.
  const custom = sheets.filter((s) => /(custom|special)\s*instructions?/i.test(s.name));
  const named = sheets.filter((s) => /instruction|تعليمات|names?\s*(and|&)\s*numbers?|printing/i.test(s.name) && !/laying|fabric|marker/i.test(s.name));
  const pick = custom.length > 0 ? custom : named.length > 0 ? named : sheets;
  return pick.flatMap((s) => readInstructionSheet(s, fileName)).slice(0, 50);
}

// ── Files ───────────────────────────────────────────────────────────────────

function cellIn(cell: ExcelJS.Cell): GridCellIn {
  const v = cell.value as unknown;
  if (v == null) return { text: '', formula: false };
  if (v instanceof Date) return { text: Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10), formula: false };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) {
      const r = o.result;
      return { text: r == null || typeof r === 'object' ? '' : String(r), formula: true };
    }
    if (Array.isArray(o.richText)) return { text: (o.richText as Array<{ text: string }>).map((t) => t.text).join(''), formula: false };
    if (typeof o.text === 'string') return { text: o.text, formula: false };
    return { text: '', formula: false };
  }
  return { text: String(v), formula: false };
}

function sheetIn(ws: ExcelJS.Worksheet): SheetIn {
  const rows: GridCellIn[][] = [];
  const width = Math.min(ws.columnCount, 60);
  for (let r = 1; r <= Math.min(ws.rowCount, 2000); r++) {
    const row = ws.getRow(r);
    const cells: GridCellIn[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellIn(row.getCell(c)));
    rows.push(cells);
  }
  return { name: ws.name, rows };
}

/** A spreadsheet (.xlsx, .xlsm or .csv) into instruction drafts. */
export async function readInstructionFile(buffer: Buffer, fileName: string): Promise<InstructionDraft[]> {
  const kind = detectFileKind(buffer, fileName);
  if (kind !== 'xlsx' && kind !== 'csv') {
    throw new BadRequestError('Upload the instructions as an Excel file (.xlsx or .xlsm) or a CSV.');
  }
  const wb = kind === 'csv' ? await readCsvWorkbook(buffer) : await openWorkbook(buffer);
  return readInstructionSheets(wb.worksheets.filter((w) => w.state !== 'hidden').map(sheetIn), fileName);
}
