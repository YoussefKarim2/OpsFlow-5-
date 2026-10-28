/**
 * The factory's own laying sheet, read as the sheet is laid out.
 *
 * "Laying fabric instructions_Patr" — exported on its own as "Florida
 * layering.xlsx" or pasted as a CSV — is not a flat table, so the generic
 * column reader picked a data row as the header and recognised nothing. It is:
 *
 *   - a title block: Po No, Order Name, Item Type, Gender, Client, Fabric 1–3,
 *     Fabric Description, Cut Percentage, Spread Notes, the season on its own;
 *   - the lay table: fabric | Color | PANAL | SIZE | one column per size |
 *     Total | Layers | Total Length | NEST | Marker Length | EFF% | MAXLAYER,
 *     with a "Ratio / Qty" row beneath the header (the cut requirement per
 *     size), one row per lay, a TOTAL row and a (+/-) row;
 *   - the sign-off lines: Cut By, Numbring By, Inspected By, Bundelled By,
 *     Approved;
 *   - a FABRIC / COLOR / METER summary;
 *   - to the right, one table per garment part set, headed "Color | sizes |
 *     Total | PANAL": for each colour, the parts (front, back, sl, collar…) and
 *     how many of each are cut per size.
 *
 * Broken references ("#REF!") and formulas without a cached result read as
 * empty, so a sheet copied out of its workbook reads the same as one still
 * inside it. Nothing here touches the database.
 */

import type ExcelJS from 'exceljs';

export interface AgeLay {
  /** The sheet row, for messages. */
  sheetRow: number;
  fabric: string | null;
  color: string | null;
  panel: string | null;
  sizeRatio: string | null;
  bySize: Record<string, number>;
  total: number | null;
  layers: number | null;
  totalLengthM: number | null;
  nestPcs: number | null;
  markerLengthM: number | null;
  efficiencyPct: number | null;
  maxLayer: number | null;
}

export interface AgePanelTable {
  title: string | null;
  sizes: string[];
  colours: Array<{ colour: string; parts: Array<{ part: string; bySize: Record<string, number>; total: number }> }>;
}

/**
 * One of the body fabric's per-colour tables, to the right of the lay table.
 *
 * The sheet plans the body fabric colour by colour and size by size rather
 * than as ratio lays: a PIECES table (how many of each size per colour, with
 * EFF / LENGHT / RATE per size above it — marker efficiency, marker length
 * and pieces per layer), a LAYER table (layers per colour and size, pieces ÷
 * rate rounded up) and a METER table (layers × marker length). Each colour
 * and size is therefore one lay. A second copy of the three sits further
 * right, used as a working copy; its rows are read too and told apart by
 * `block`.
 */
export interface AgeColourTable {
  /** Which copy: 1 for the leftmost set, 2 for the next. */
  block: number;
  kind: 'PIECES' | 'LAYERS' | 'METERS' | 'OTHER';
  title: string | null;
  sizes: string[];
  rows: Array<{ fabric: string | null; colour: string; panel: string | null; bySize: Record<string, number>; total: number | null }>;
  totals: { bySize: Record<string, number>; total: number | null } | null;
  /** The per-size parameters above a PIECES table. */
  params: { eff: Record<string, number>; markerLengthM: Record<string, number>; rate: Record<string, number> } | null;
}

/**
 * A row of a fabric table in the bill-of-materials layout — "Item Sort /
 * Dep. | Item | Description | Color | Qty | Unit | Material issued |
 * Shortage | Issued to" — which this sheet uses for the fabric each colour
 * needs, instead of the FABRIC / COLOR / METER summary.
 */
export interface AgeFabricLine {
  department: string | null;
  item: string;
  description: string | null;
  colour: string | null;
  qty: number | null;
  unit: string | null;
  issued: number | null;
  shortage: number | null;
  issuedTo: string | null;
}

export interface AgeLayingSheet {
  sheetName: string;
  headerRow: number;
  header: {
    poNumber: string | null; orderName: string | null; itemType: string | null; gender: string | null;
    client: string | null; season: string | null; fabrics: string[]; fabricDescription: string | null;
    cutPercentage: number | null; spreadNotes: string | null;
    /** "Cut Notes :" — the cutting room's own note. */
    cutNotes: string | null;
    /** "Fabric Date to External :" — ISO date, when the sheet has one. */
    fabricDateToExternal: string | null;
  };
  sizes: string[];
  requirement: { bySize: Record<string, number>; total: number | null } | null;
  lays: AgeLay[];
  totals: {
    bySize: Record<string, number>; total: number | null; layers: number | null; totalLengthM: number | null;
    nestPcs: number | null; markerLengthM: number | null; maxLayer: number | null;
  } | null;
  variance: { bySize: Record<string, number>; total: number | null } | null;
  signatures: { cutBy: string | null; numberingBy: string | null; inspectedBy: string | null; bundledBy: string | null; approvedBy: string | null };
  /**
   * Fabric needed per fabric and colour: the FABRIC / COLOR / METER summary,
   * or, when the sheet has none, its fabric tables in the BOM layout — which
   * also say what was issued and to whom.
   */
  fabricSummary: Array<{ fabric: string; color: string | null; meters: number | null; issuedM?: number | null; issuedTo?: string | null }>;
  panelTables: AgePanelTable[];
  colourTables: AgeColourTable[];
  fabricLines: AgeFabricLine[];
}

// ── Cells ───────────────────────────────────────────────────────────────────

const ERROR_TEXT = /^#(REF|VALUE|N\/A|DIV\/0|NAME|NUM|NULL)!?$|^\[object Object\]$/i;

/** A cell's text: formula results and rich text unwrapped, errors and empty formulas blank. */
export function cellStr(cell: ExcelJS.Cell | undefined): string {
  const v = cell?.value as unknown;
  if (v == null) return '';
  let out: unknown = v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('error' in o) return '';
    if (Array.isArray(o.richText)) out = (o.richText as Array<{ text: string }>).map((t) => t.text).join('');
    else if ('result' in o) {
      const r = o.result;
      if (r == null || (typeof r === 'object' && r !== null && 'error' in (r as object))) return '';
      out = r;
    } else if ('formula' in o || 'sharedFormula' in o) return '';
    else if (typeof o.text === 'string') out = o.text;
    else if (v instanceof Date) out = v.toISOString().slice(0, 10);
    else return '';
  }
  const s = String(out).replace(/\s+/g, ' ').trim();
  return ERROR_TEXT.test(s) ? '' : s;
}

function cellNum(cell: ExcelJS.Cell | undefined): number | null {
  const s = cellStr(cell).replace(/[,\s%]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "Marker  Length" → "marker length"; "PANAL" → "panal"; "Po No :" → "po no". */
const key = (s: string) => s.toLowerCase().replace(/[:：]/g, ' ').replace(/[^a-z0-9%+/()\-]+/g, ' ').trim();

// ── The lay table ───────────────────────────────────────────────────────────

const HEADING: Array<[keyof Cols, RegExp]> = [
  ['fabric', /^fabric$/],
  ['color', /^colou?r$/],
  ['panel', /^pana?l$|^panel$/],
  ['size', /^size$/],
  ['total', /^total$/],
  ['layers', /^layers?$/],
  ['totalLength', /^total length$/],
  ['nest', /^nest$/],
  ['markerLength', /^marker length$/],
  ['eff', /^eff ?%?$|^efficiency$/],
  ['maxLayer', /^max ?layers?$/],
];
interface Cols {
  fabric?: number; color?: number; panel?: number; size?: number; total?: number; layers?: number;
  totalLength?: number; nest?: number; markerLength?: number; eff?: number; maxLayer?: number;
}

function findHeader(ws: ExcelJS.Worksheet): { row: number; cols: Cols } | null {
  const maxCol = Math.min(ws.columnCount || 80, 80);
  for (let r = 1; r <= Math.min(ws.rowCount || 60, 60); r++) {
    const row = ws.getRow(r);
    const cols: Cols = {};
    for (let c = 1; c <= maxCol; c++) {
      const k = key(cellStr(row.getCell(c)));
      if (!k) continue;
      for (const [name, re] of HEADING) if (cols[name] == null && re.test(k)) { cols[name] = c; break; }
    }
    if (cols.fabric != null && cols.layers != null && cols.size != null && cols.color != null && cols.size < cols.layers) {
      return { row: r, cols };
    }
  }
  return null;
}

/** The size headings between SIZE and Total: text, not a broken reference. */
function sizeColumns(ws: ExcelJS.Worksheet, headerRow: number, cols: Cols): Array<{ col: number; name: string }> {
  const out: Array<{ col: number; name: string }> = [];
  const end = cols.total ?? cols.layers!;
  const row = ws.getRow(headerRow);
  for (let c = cols.size! + 1; c < end; c++) {
    const name = cellStr(row.getCell(c));
    if (name) out.push({ col: c, name });
  }
  return out;
}

function readBySize(row: ExcelJS.Row, sizes: ReadonlyArray<{ col: number; name: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sizes) {
    const n = cellNum(row.getCell(s.col));
    if (n != null && n !== 0) out[s.name] = n;
  }
  return out;
}

/** "(YXS1), (YS1)" from pieces per size and the layer count, when the sheet left the ratio blank. */
function ratioFrom(bySize: Record<string, number>, layers: number | null): string | null {
  if (!layers || layers <= 0) return null;
  const parts = Object.entries(bySize).map(([size, qty]) => `(${size}${Math.max(1, Math.round(qty / layers))})`);
  return parts.length > 0 ? parts.join(', ') : null;
}

// ── The title block ─────────────────────────────────────────────────────────

const TITLE_LABELS: Array<[string, RegExp]> = [
  ['poNumber', /^po no$|^po number$|^po$|^order no$/],
  ['orderName', /^order name$/],
  ['itemType', /^item type$/],
  ['gender', /^gender$/],
  ['client', /^client$|^customer$/],
  ['fabric1', /^fabric ?1$|^fabric$|^main fabric$/],
  ['fabric2', /^fabric ?2$/],
  ['fabric3', /^fabric ?3$/],
  ['fabricDescription', /^fabric description$/],
  ['cutPercentage', /^cut percentage$|^cut %$/],
  ['spreadNotes', /^spread notes?$/],
  ['cutNotes', /^cut notes?$/],
  ['fabricDateToExternal', /^fabric date to external$/],
];

/** The value beside a label: the first cell to the right that says something other than the label. */
function valueRightOf(row: ExcelJS.Row, col: number, label: string, maxCol: number, stopAt?: (t: string) => boolean): string | null {
  for (let c = col + 1; c <= Math.min(maxCol, col + 14); c++) {
    const t = cellStr(row.getCell(c));
    if (!t || t === label) continue;
    if (stopAt?.(t)) return null;
    return t;
  }
  return null;
}

function readTitleBlock(ws: ExcelJS.Worksheet, headerRow: number): AgeLayingSheet['header'] {
  const maxCol = Math.min(ws.columnCount || 80, 80);
  const found: Record<string, string> = {};
  let season: string | null = null;
  // "Fabric 4", "Fabric 5" are labels of further slots, not the fabric in
  // the blank slot before them.
  const isLabel = (t: string) => TITLE_LABELS.some(([, re]) => re.test(key(t))) || /^fabric ?\d+$/.test(key(t));
  for (let r = 1; r < headerRow; r++) {
    const row = ws.getRow(r);
    const texts = new Set<string>();
    for (let c = 1; c <= maxCol; c++) {
      const t = cellStr(row.getCell(c));
      if (!t) continue;
      texts.add(t);
      const k = key(t);
      for (const [name, re] of TITLE_LABELS) {
        if (found[name] != null || !re.test(k)) continue;
        const v = valueRightOf(row, c, t, maxCol, isLabel);
        if (v != null) found[name] = v;
      }
    }
    // A row that says one thing, with no label, above the labels: the season.
    if (!season && texts.size === 1 && Object.keys(found).length === 0) {
      const only = [...texts][0]!;
      if (/\b(ss|fw|aw|summer|winter|spring|autumn|fall)\b|\d{2}\/\d{2}/i.test(only) && !/sheet\s*\d/i.test(only)) season = only;
    }
  }
  const fabrics = [found.fabric1, found.fabric2, found.fabric3].filter((f): f is string => !!f && f !== '0');
  const pct = found.cutPercentage ? Number(found.cutPercentage.replace('%', '')) : null;
  const dateText = found.fabricDateToExternal ?? null;
  const date = dateText && /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : null;
  return {
    poNumber: found.poNumber ?? null, orderName: found.orderName ?? null, itemType: found.itemType ?? null,
    gender: found.gender ?? null, client: found.client ?? null, season, fabrics,
    fabricDescription: found.fabricDescription && found.fabricDescription !== '0' ? found.fabricDescription : null,
    cutPercentage: pct != null && Number.isFinite(pct) ? (pct > 1 ? pct / 100 : pct) : null,
    spreadNotes: found.spreadNotes && found.spreadNotes !== '0' ? found.spreadNotes : null,
    cutNotes: found.cutNotes && found.cutNotes !== '0' ? found.cutNotes : null,
    fabricDateToExternal: date,
  };
}

// ── Sign-off lines and the fabric summary ───────────────────────────────────

const SIGN_LABELS: Array<[keyof AgeLayingSheet['signatures'], RegExp]> = [
  ['cutBy', /^cut by$/],
  ['numberingBy', /^numb(e)?ring by$/],
  ['inspectedBy', /^inspected by$/],
  ['bundledBy', /^bund(e)?l+ed by$/],
  ['approvedBy', /^approved( by)?$/],
];

function readSignatures(ws: ExcelJS.Worksheet, from: number, avoidCols: ReadonlySet<number>): AgeLayingSheet['signatures'] {
  const out: AgeLayingSheet['signatures'] = { cutBy: null, numberingBy: null, inspectedBy: null, bundledBy: null, approvedBy: null };
  const maxCol = Math.min(ws.columnCount || 80, 80);
  const isLabel = (t: string) => SIGN_LABELS.some(([, re]) => re.test(key(t))) || /^(fabric|colou?r|meter)$/i.test(t);
  for (let r = from; r <= Math.min(ws.rowCount || from, from + 15); r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= maxCol; c++) {
      const t = cellStr(row.getCell(c));
      if (!t) continue;
      const hit = SIGN_LABELS.find(([, re]) => re.test(key(t)));
      if (!hit || out[hit[0]] != null) continue;
      // Beside the label, else beneath it ("Approved" over "A.S"). The fabric
      // summary shares these rows, so its columns are never a signature.
      const limit = [...avoidCols].filter((x) => x > c).sort((a, b) => a - b)[0] ?? maxCol;
      let v = valueRightOf(row, c, t, Math.min(maxCol, limit - 1), isLabel);
      if (v == null) {
        const below = cellStr(ws.getRow(r + 1).getCell(c));
        if (below && !isLabel(below)) v = below;
      }
      if (v != null) out[hit[0]] = v;
    }
  }
  return out;
}

function readFabricSummary(ws: ExcelJS.Worksheet, from: number): { rows: AgeLayingSheet['fabricSummary']; cols: Set<number> } {
  const maxCol = Math.min(ws.columnCount || 80, 80);
  for (let r = from; r <= Math.min(ws.rowCount || from, from + 15); r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= maxCol - 2; c++) {
      if (key(cellStr(row.getCell(c))) !== 'fabric' || key(cellStr(row.getCell(c + 1))) !== 'color' || key(cellStr(row.getCell(c + 2))) !== 'meter') continue;
      const out: AgeLayingSheet['fabricSummary'] = [];
      for (let k = r + 1; k <= r + 10; k++) {
        const fabric = cellStr(ws.getRow(k).getCell(c));
        if (!fabric) break;
        out.push({ fabric, color: cellStr(ws.getRow(k).getCell(c + 1)) || null, meters: cellNum(ws.getRow(k).getCell(c + 2)) });
      }
      return { rows: out, cols: new Set([c, c + 1, c + 2]) };
    }
  }
  return { rows: [], cols: new Set() };
}

// ── Panel tables ────────────────────────────────────────────────────────────

const PART = /^(front|back|sl|sleeves?|sleeve ?\(?[rl]\)?|collar|cuffs?|neck( fabric)?|pana?l|track|rib( collar| cuff)?|yoke|pocket|hood|placket)$/i;

const PART_NAME: Record<string, string> = { sl: 'Sleeve', panal: 'Panel' };
function partName(raw: string): string {
  const k = raw.trim().toLowerCase();
  if (PART_NAME[k]) return PART_NAME[k]!;
  return k.charAt(0).toUpperCase() + k.slice(1);
}

function readPanelTables(ws: ExcelJS.Worksheet, headerRow: number, mainSizes: readonly string[]): AgePanelTable[] {
  const tables: AgePanelTable[] = [];
  const maxCol = Math.min(ws.columnCount || 80, 80);
  const maxRow = Math.min(ws.rowCount || 200, 200);
  const sizeSet = new Set(mainSizes.map((s) => s.toUpperCase()));
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= maxCol; c++) {
      if (!/^colou?r$/.test(key(cellStr(row.getCell(c))))) continue;
      // The sizes must follow directly — that is what tells this "Color" from the lay table's.
      const sizes: Array<{ col: number; name: string }> = [];
      let totalCol: number | null = null;
      for (let k = c + 1; k <= Math.min(maxCol, c + 20); k++) {
        const t = cellStr(row.getCell(k));
        if (!t) continue;
        if (/^total$/i.test(t)) { totalCol = k; break; }
        if (sizeSet.size === 0 || sizeSet.has(t.toUpperCase())) sizes.push({ col: k, name: t });
        else if (sizes.length === 0) break;
      }
      if (sizes.length < 2 || (sizeSet.size > 0 && sizes.length < Math.min(3, sizeSet.size))) continue;
      if (r === headerRow) continue;
      // The title sits above the "Color" cell, within a few rows.
      let title: string | null = null;
      for (let k = r - 1; k >= Math.max(1, r - 3); k--) {
        const t = cellStr(ws.getRow(k).getCell(c));
        if (t && !/^colou?r$/i.test(t)) { title = t; break; }
      }
      const colours: AgePanelTable['colours'] = [];
      let current: AgePanelTable['colours'][number] | null = null;
      let blank = 0;
      for (let k = r + 1; k <= Math.min(maxRow, r + 40); k++) {
        const line = ws.getRow(k);
        const label = cellStr(line.getCell(c));
        if (/^totals?$/i.test(label)) break;
        if (!label) { if (++blank >= 6) break; continue; }
        blank = 0;
        if (/^colou?r$/i.test(label)) break; // the next table's header
        if (PART.test(label)) {
          const bySize = readBySize(line, sizes);
          const total = totalCol != null ? cellNum(line.getCell(totalCol)) ?? 0 : Object.values(bySize).reduce((a, b) => a + b, 0);
          if (total > 0 || Object.keys(bySize).length > 0) {
            if (!current) { current = { colour: 'Unnamed', parts: [] }; colours.push(current); }
            current.parts.push({ part: partName(label), bySize, total: total || Object.values(bySize).reduce((a, b) => a + b, 0) });
          }
        } else {
          current = { colour: label, parts: [] };
          colours.push(current);
        }
      }
      const kept = colours.filter((x) => x.parts.length > 0);
      if (kept.length > 0) tables.push({ title, sizes: sizes.map((s) => s.name), colours: kept });
      r += 1; // the tables are side by side with the lay table; keep scanning below
    }
  }
  return tables;
}

// ── The body fabric's colour tables ─────────────────────────────────────────

const PARAM_LABELS: Array<[keyof NonNullable<AgeColourTable['params']>, RegExp]> = [
  ['eff', /^eff ?%?$|^efficiency$/],
  ['markerLengthM', /^leng?h?th$|^lenght$|^marker length$/],
  ['rate', /^rate$|^pcs ?\/ ?layer$/],
];

/**
 * The per-colour tables: a header "fabric | Color | PANAL | sizes… | Total"
 * other than the lay table's own, the rows beneath it down to "Totals", and
 * for the first table of a set the EFF / LENGHT / RATE rows above it.
 */
function readColourTables(ws: ExcelJS.Worksheet, layHeader: { row: number; cols: Cols }, mainSizes: readonly string[]): AgeColourTable[] {
  const tables: AgeColourTable[] = [];
  const maxCol = Math.min(ws.columnCount || 80, 120);
  const maxRow = Math.min(ws.rowCount || 200, 200);
  const sizeSet = new Set(mainSizes.map((s) => s.toUpperCase()));
  const blockCols: number[] = [];
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= maxCol; c++) {
      if (key(cellStr(row.getCell(c))) !== 'fabric') continue;
      if (r === layHeader.row && c === layHeader.cols.fabric) continue;
      // The colour heading may be a formula without a result; the panel one is fixed.
      if (!/^pana?l$|^panel$/.test(key(cellStr(row.getCell(c + 2))))) continue;
      const sizes: Array<{ col: number; name: string }> = [];
      let totalCol: number | null = null;
      for (let k = c + 3; k <= Math.min(maxCol, c + 24); k++) {
        const t = cellStr(row.getCell(k));
        if (!t) continue;
        if (/^total$/i.test(t)) { totalCol = k; break; }
        if (sizeSet.size === 0 || sizeSet.has(t.toUpperCase())) sizes.push({ col: k, name: t });
        else break;
      }
      if (sizes.length < 2) continue;

      let title: string | null = null;
      for (let k = r - 1; k >= Math.max(1, r - 3); k--) {
        const t = cellStr(ws.getRow(k).getCell(c));
        if (t) { title = t; break; }
      }
      let block = blockCols.indexOf(c) + 1;
      if (block === 0) { blockCols.push(c); block = blockCols.length; }
      const first = !tables.some((t) => t.block === block);
      const kind: AgeColourTable['kind'] = /layer/i.test(title ?? '') ? 'LAYERS'
        : /met(er|re)/i.test(title ?? '') ? 'METERS'
        : first ? 'PIECES' : 'OTHER';

      // EFF / LENGHT / RATE sit in the colour column a few rows up, their
      // values under the size columns.
      let params: AgeColourTable['params'] = null;
      if (kind === 'PIECES') {
        const p: NonNullable<AgeColourTable['params']> = { eff: {}, markerLengthM: {}, rate: {} };
        for (let k = Math.max(1, r - 6); k < r; k++) {
          const line = ws.getRow(k);
          const label = key(cellStr(line.getCell(c + 1)));
          const hit = PARAM_LABELS.find(([, re]) => re.test(label));
          if (!hit) continue;
          for (const s of sizes) { const n = cellNum(line.getCell(s.col)); if (n != null) p[hit[0]][s.name] = n; }
        }
        if (Object.keys(p.rate).length > 0 || Object.keys(p.markerLengthM).length > 0 || Object.keys(p.eff).length > 0) params = p;
      }

      const rows: AgeColourTable['rows'] = [];
      let totals: AgeColourTable['totals'] = null;
      for (let k = r + 1; k <= Math.min(maxRow, r + 60); k++) {
        const line = ws.getRow(k);
        const fabric = cellStr(line.getCell(c)) || null;
        const colour = cellStr(line.getCell(c + 1));
        const bySize = readBySize(line, sizes);
        if (/^totals?$/i.test(colour) || (!fabric && /^totals?$/i.test(cellStr(line.getCell(c))))) {
          totals = { bySize, total: totalCol != null ? cellNum(line.getCell(totalCol)) : null };
          break;
        }
        if (!fabric && !colour) { if (Object.keys(bySize).length === 0) break; continue; }
        if (!colour) continue;
        rows.push({ fabric, colour, panel: cellStr(line.getCell(c + 2)) || null, bySize, total: totalCol != null ? cellNum(line.getCell(totalCol)) : null });
      }
      tables.push({ block, kind, title, sizes: sizes.map((s) => s.name), rows, totals, params });
      c += 3;
    }
  }
  return tables;
}

// ── Fabric tables in the bill-of-materials layout ───────────────────────────

const FABRIC_LINE_HEAD: Array<[keyof AgeFabricLine, RegExp]> = [
  ['department', /^item sort/],
  ['item', /^item$/],
  ['description', /^description$/],
  ['colour', /^colou?r$/],
  ['qty', /^qty$|^quantity$|^order qty$/],
  ['unit', /^unit$/],
  ['issued', /^material issued$|^issued$/],
  ['shortage', /^shortage$/],
  ['issuedTo', /^issued to$/],
];

function readFabricLines(ws: ExcelJS.Worksheet): AgeFabricLine[] {
  const out: AgeFabricLine[] = [];
  const maxCol = Math.min(ws.columnCount || 80, 120);
  const maxRow = Math.min(ws.rowCount || 200, 200);
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= maxCol; c++) {
      if (!/^item sort/.test(key(cellStr(row.getCell(c))))) continue;
      const cols: Partial<Record<keyof AgeFabricLine, number>> = {};
      for (let k = c; k <= Math.min(maxCol, c + 12); k++) {
        const t = key(cellStr(row.getCell(k)));
        if (!t) continue;
        const hit = FABRIC_LINE_HEAD.find(([name, re]) => cols[name] == null && re.test(t));
        if (hit) cols[hit[0]] = k;
      }
      if (cols.item == null || cols.qty == null) continue;
      const str = (line: ExcelJS.Row, name: keyof AgeFabricLine) => (cols[name] == null ? null : cellStr(line.getCell(cols[name]!)) || null);
      const num = (line: ExcelJS.Row, name: keyof AgeFabricLine) => (cols[name] == null ? null : cellNum(line.getCell(cols[name]!)));
      for (let k = r + 1; k <= Math.min(maxRow, r + 40); k++) {
        const line = ws.getRow(k);
        const item = str(line, 'item');
        if (!item) break;
        out.push({
          department: str(line, 'department'), item, description: str(line, 'description'), colour: str(line, 'colour'),
          qty: num(line, 'qty'), unit: str(line, 'unit'), issued: num(line, 'issued'), shortage: num(line, 'shortage'), issuedTo: str(line, 'issuedTo'),
        });
      }
      c += 8;
    }
  }
  return out;
}

const fabricKey = (fabric: string, colour: string | null) => `${fabric.trim().toLowerCase()}|${(colour ?? '').trim().toLowerCase()}`;

// ── The whole sheet ─────────────────────────────────────────────────────────

export function readAgeLayingSheet(ws: ExcelJS.Worksheet): AgeLayingSheet | null {
  const header = findHeader(ws);
  if (!header) return null;
  const { row: headerRow, cols } = header;
  const sizes = sizeColumns(ws, headerRow, cols);
  const sizeNames = sizes.map((s) => s.name);

  let r = headerRow + 1;
  let requirement: AgeLayingSheet['requirement'] = null;
  if (/ratio|qty|quantity/i.test(cellStr(ws.getRow(r).getCell(cols.size!)))) {
    const row = ws.getRow(r);
    requirement = { bySize: readBySize(row, sizes), total: cols.total != null ? cellNum(row.getCell(cols.total)) : null };
    r += 1;
  }

  const lays: AgeLay[] = [];
  let totals: AgeLayingSheet['totals'] = null;
  let variance: AgeLayingSheet['variance'] = null;
  let totalsRow = headerRow;
  for (; r <= Math.min(ws.rowCount || r, headerRow + 80); r++) {
    const row = ws.getRow(r);
    const sizeText = cellStr(row.getCell(cols.size!));
    if (/^total$/i.test(sizeText)) {
      totals = {
        bySize: readBySize(row, sizes),
        total: cols.total != null ? cellNum(row.getCell(cols.total)) : null,
        layers: cellNum(row.getCell(cols.layers!)),
        totalLengthM: cols.totalLength != null ? cellNum(row.getCell(cols.totalLength)) : null,
        nestPcs: cols.nest != null ? cellNum(row.getCell(cols.nest)) : null,
        markerLengthM: cols.markerLength != null ? cellNum(row.getCell(cols.markerLength)) : null,
        maxLayer: cols.maxLayer != null ? cellNum(row.getCell(cols.maxLayer)) : null,
      };
      totalsRow = r;
      const next = ws.getRow(r + 1);
      if (/\+\s*\/\s*[-−]|variance/i.test(cellStr(next.getCell(cols.size!)))) {
        variance = { bySize: readBySize(next, sizes), total: cols.total != null ? cellNum(next.getCell(cols.total)) : null };
      }
      break;
    }
    const fabric = cellStr(row.getCell(cols.fabric!)) || null;
    const layers = cellNum(row.getCell(cols.layers!));
    const bySize = readBySize(row, sizes);
    if (!fabric && !sizeText && layers == null && Object.keys(bySize).length === 0) continue;
    const ratio = sizeText || ratioFrom(bySize, layers);
    lays.push({
      sheetRow: r, fabric,
      color: cols.color != null ? cellStr(row.getCell(cols.color)) || null : null,
      panel: cols.panel != null ? cellStr(row.getCell(cols.panel)) || null : null,
      sizeRatio: ratio, bySize,
      total: cols.total != null ? cellNum(row.getCell(cols.total)) : null,
      layers,
      totalLengthM: cols.totalLength != null ? cellNum(row.getCell(cols.totalLength)) : null,
      nestPcs: cols.nest != null ? cellNum(row.getCell(cols.nest)) : null,
      markerLengthM: cols.markerLength != null ? cellNum(row.getCell(cols.markerLength)) : null,
      efficiencyPct: cols.eff != null ? cellNum(row.getCell(cols.eff)) : null,
      maxLayer: cols.maxLayer != null ? cellNum(row.getCell(cols.maxLayer)) : null,
    });
  }

  const fabricSummary = readFabricSummary(ws, totalsRow + 1);
  const fabricLines = readFabricLines(ws);
  // No FABRIC / COLOR / METER summary: the fabric tables say it instead, one
  // row per fabric and colour. The working copy repeats a colour; the first
  // row wins.
  let summary = fabricSummary.rows;
  if (summary.length === 0 && fabricLines.length > 0) {
    const seen = new Set<string>();
    summary = [];
    for (const l of fabricLines) {
      if (l.department && !/fabric/i.test(l.department)) continue;
      const k = fabricKey(l.item, l.colour);
      if (seen.has(k)) continue;
      seen.add(k);
      summary.push({ fabric: l.item, color: l.colour, meters: l.qty, issuedM: l.issued, issuedTo: l.issuedTo });
    }
  }
  return {
    sheetName: ws.name, headerRow,
    header: readTitleBlock(ws, headerRow),
    sizes: sizeNames, requirement, lays, totals, variance,
    signatures: readSignatures(ws, totalsRow + 1, fabricSummary.cols),
    fabricSummary: summary,
    panelTables: readPanelTables(ws, headerRow, sizeNames),
    colourTables: readColourTables(ws, header, sizeNames),
    fabricLines,
  };
}
