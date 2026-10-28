/**
 * Laying & Marking Excel extraction.
 *
 * A dedicated, deliberately smaller reader than tabular-extractor.ts. A
 * laying/marking sheet is a flat table — one row per lay — with no
 * colour×size matrix to build, so the WIDE/LONG layout logic over there does
 * not apply here. What is reused is the *candidate* row-finding
 * (`findHeaderCandidates`/`readTableAt`) and the column-scoring engine
 * (`analyseColumns`), both scoped to just the laying/marking concepts.
 *
 * Deliberately NOT `readSheetTable` — that picks the best header row using
 * `scoreTable`, which rewards order-matrix concepts (colour, size, quantity)
 * regardless of caller. A laying sheet has none of those, so letting it pick
 * can and did choose the wrong row (a data row scored higher than the real
 * header once "Size Ratio" — a concept this file added — stopped counting
 * toward `scoreTable`'s generic SIZE bonus). Each header-row candidate is
 * scored here instead, by how many *laying* concepts it matches.
 */

import ExcelJS from 'exceljs';
import {
  analyseColumns, assessMapping, ImportConcept, CONCEPT_META, safeDate,
  type ColumnAnalysis, type ImportIssue,
} from '@opsflow/shared';
import { findHeaderCandidates, readTableAt, type SheetTable } from './tabular-extractor.js';
import { openWorkbook, readCsvWorkbook } from './open-workbook.js';
import { detectFileKind } from './file-kind.js';
import { readAgeLayingSheet, type AgeLayingSheet } from './age-laying-reader.js';

const LAYING_CONCEPTS = new Set<ImportConcept>([
  // MATERIAL as well as FABRIC: plenty of laying sheets head that column
  // "Material" rather than "Fabric", and both already mean the same field on
  // an order. Without it the column scored as a concept this reader ignores,
  // and the fabric came through empty on a sheet that plainly stated it.
  ImportConcept.MATERIAL,
  ImportConcept.LAY_NUMBER, ImportConcept.MARKER_NUMBER, ImportConcept.FABRIC,
  ImportConcept.COLOR, ImportConcept.PANEL, ImportConcept.SIZE_RATIO,
  ImportConcept.LAYERS, ImportConcept.MARKER_LENGTH, ImportConcept.MARKER_WIDTH,
  ImportConcept.TOTAL_LENGTH, ImportConcept.FABRIC_CONSUMPTION, ImportConcept.WASTAGE,
  ImportConcept.NEST_PCS, ImportConcept.EFFICIENCY, ImportConcept.CUT_DATE,
  ImportConcept.RESPONSIBLE_PERSON, ImportConcept.PO_NUMBER, ImportConcept.NOTES,
]);

/** A lay is not usable without a fabric, a layer count and a marker length. */
const LAYING_ESSENTIALS: readonly ImportConcept[] = [
  ImportConcept.FABRIC, ImportConcept.LAYERS, ImportConcept.MARKER_LENGTH,
];

export interface LayingRow {
  /** Position among the detected data rows — 1 is the first, not a sheet line number. */
  rowNumber: number;
  markerNumber: string | null;
  fabricName: string | null;
  fabricColor: string | null;
  panel: string | null;
  sizeRatio: string | null;
  layers: number | null;
  markerLengthM: number | null;
  markerWidthM: number | null;
  totalLengthM: number | null;
  nestPcs: number | null;
  efficiencyPct: number | null;
  wastagePct: number | null;
  fabricConsumptionM: number | null;
  cutDate: Date | null;
  cutByName: string | null;
  poNumber: string | null;
  /** The sheet's MAXLAYER column, where it has one. */
  maxLayer: number | null;
  /**
   * LAY: a marker spread in layers. PANEL: a row of the factory sheet's
   * per-colour panel tables — how many of one part (front, back, sleeve,
   * collar) are cut per size for one colour. Stored as a one-layer marker of
   * that part so the order keeps it; never counted as garments.
   */
  kind: 'LAY' | 'PANEL';
}

/** What the factory's own laying sheet says beyond its lay rows. */
export interface LayingExtras {
  layout: 'AGE';
  sizes: string[];
  header: AgeLayingSheet['header'];
  requirement: AgeLayingSheet['requirement'];
  totals: AgeLayingSheet['totals'];
  variance: AgeLayingSheet['variance'];
  signatures: AgeLayingSheet['signatures'];
  fabricSummary: AgeLayingSheet['fabricSummary'];
  panelTables: AgeLayingSheet['panelTables'];
  /** The body fabric's per-colour tables (pieces, layers, meters by size). */
  colourTables: AgeLayingSheet['colourTables'];
  /** The sheet's fabric tables in the bill-of-materials layout. */
  fabricLines: AgeLayingSheet['fabricLines'];
}

export interface LayingAnalysis {
  sheetName: string;
  headerRowIndex: number;
  columns: ColumnAnalysis[];
  readiness: ReturnType<typeof assessMapping>;
  candidateSheets: Array<{ name: string; rows: number }>;
  rowsDetected: number;
}

export interface LayingExtractionResult {
  analysis: LayingAnalysis;
  rows: LayingRow[];
  issues: ImportIssue[];
  /** Every distinct PO number found in the data, for the order-match check. */
  detectedPoNumbers: string[];
  /** Present when the file is the factory's own laying sheet layout. */
  extras?: LayingExtras;
}

/**
 * The factory's own laying sheet, read by its layout rather than by scoring
 * columns. The column scorer saw a data row as the header and recognised
 * nothing of it; this reads the title block, the Ratio/Qty row, the lays, the
 * TOTAL and (+/-) rows, the sign-off lines, the fabric summary and the
 * per-colour panel tables as the sheet lays them out.
 */
function fromAgeSheet(age: AgeLayingSheet, candidateSheets: Array<{ name: string; rows: number }>): LayingExtractionResult {
  const issues: ImportIssue[] = [];
  const rows: LayingRow[] = [];
  const blank = {
    markerNumber: null, markerWidthM: null, wastagePct: null, fabricConsumptionM: null, cutDate: null, cutByName: null, poNumber: null,
  };
  // The sheet's PO number is in its title block, not a column. Carried on
  // every row so the commit's wrong-file check sees it, as it would a column.
  const poNumber = age.header.poNumber;
  for (const l of age.lays) {
    rows.push({
      ...blank, poNumber, rowNumber: rows.length + 1, kind: 'LAY',
      fabricName: l.fabric ?? age.header.fabrics[0] ?? null, fabricColor: l.color, panel: l.panel ?? 'ALL',
      sizeRatio: l.sizeRatio, layers: l.layers == null ? null : Math.round(l.layers), markerLengthM: l.markerLengthM,
      totalLengthM: l.totalLengthM, nestPcs: l.nestPcs, efficiencyPct: l.efficiencyPct,
      maxLayer: l.maxLayer == null ? null : Math.round(l.maxLayer),
    });
    if (l.layers == null) {
      issues.push({ level: 'WARNING', field: 'layers', sheet: age.sheetName, cell: `row ${l.sheetRow}`, message: `Sheet row ${l.sheetRow}: no layer count; the lay is imported with 0 layers.` });
    }
  }
  const mainFabric = age.header.fabrics[0] ?? age.lays[0]?.fabric ?? null;

  // The body fabric's colour tables: the sheet plans it colour by colour and
  // size by size — pieces, then layers (pieces ÷ the size's rate), then
  // meters (layers × the size's marker length) — so each colour and size is
  // one lay, with the ratio "(YXS3)" the RATE row gives it. A working copy of
  // the tables further right repeats colours; a row equal to one already
  // read is the same plan twice, and a negative figure is an adjustment, not
  // a lay.
  let colourLays = 0;
  let repeated = 0;
  const seenColour = new Map<string, Record<string, number>>();
  const colourKey = (fabric: string | null, colour: string) => `${(fabric ?? '').trim().toLowerCase()}|${colour.trim().toLowerCase()}`;
  const sameBySize = (a: Record<string, number>, b: Record<string, number>) =>
    Object.keys({ ...a, ...b }).every((s) => (a[s] ?? 0) === (b[s] ?? 0));
  const blocks = [...new Set(age.colourTables.map((t) => t.block))].sort((a, b) => a - b);
  for (const block of blocks) {
    const pieces = age.colourTables.find((t) => t.block === block && t.kind === 'PIECES');
    if (!pieces) continue;
    const layersT = age.colourTables.find((t) => t.block === block && t.kind === 'LAYERS');
    const metersT = age.colourTables.find((t) => t.block === block && t.kind === 'METERS');
    const rowOf = (t: typeof pieces | undefined, fabric: string | null, colour: string) =>
      t?.rows.find((x) => colourKey(x.fabric, x.colour) === colourKey(fabric, colour));
    for (const row of pieces.rows) {
      const k = colourKey(row.fabric, row.colour);
      const earlier = seenColour.get(k);
      if (earlier && sameBySize(earlier, row.bySize)) { repeated++; continue; }
      if (!earlier) seenColour.set(k, row.bySize);
      const layersRow = rowOf(layersT, row.fabric, row.colour);
      const metersRow = rowOf(metersT, row.fabric, row.colour);
      for (const size of pieces.sizes) {
        const n = row.bySize[size];
        if (!n || n <= 0) continue;
        const rateRaw = pieces.params?.rate[size];
        const rate = rateRaw != null && rateRaw > 0 ? Math.max(1, Math.round(rateRaw)) : 1;
        const layers = Math.round(layersRow?.bySize[size] ?? Math.ceil(n / rate));
        const markerLengthM = pieces.params?.markerLengthM[size] ?? null;
        const totalLengthM = metersRow?.bySize[size] ?? (markerLengthM != null ? Math.ceil(layers * markerLengthM) : null);
        rows.push({
          ...blank, poNumber, rowNumber: rows.length + 1, kind: 'LAY',
          fabricName: row.fabric ?? mainFabric, fabricColor: row.colour, panel: row.panel ?? 'ALL',
          sizeRatio: `(${size}${rate})`, layers, markerLengthM, totalLengthM, nestPcs: null,
          efficiencyPct: pieces.params?.eff[size] ?? null, maxLayer: null,
        });
        colourLays++;
      }
    }
  }

  let panelRows = 0;
  for (const t of age.panelTables) {
    for (const c of t.colours) {
      for (const p of c.parts) {
        const ratio = Object.entries(p.bySize).map(([size, n]) => `(${size}${n})`).join(', ');
        if (!ratio) continue;
        rows.push({
          ...blank, poNumber, rowNumber: rows.length + 1, kind: 'PANEL',
          fabricName: mainFabric, fabricColor: c.colour, panel: p.part, sizeRatio: ratio,
          layers: 1, markerLengthM: null, totalLengthM: null, nestPcs: null, efficiencyPct: null, maxLayer: null,
        });
        panelRows++;
      }
    }
  }

  const concept = (header: string, c: ImportConcept, samples: string[]): ColumnAnalysis => ({
    index: 0, header, samples: samples.slice(0, 5), guesses: [{ concept: c, confidence: 1, reason: 'The factory laying sheet layout' }],
    concept: c, confidence: 1, needsConfirmation: false, source: 'AUTO',
  });
  const lays = age.lays;
  const str = (v: unknown) => (v == null ? '' : String(v));
  const columns: ColumnAnalysis[] = [
    concept('fabric', ImportConcept.FABRIC, lays.map((l) => str(l.fabric))),
    concept('Color', ImportConcept.COLOR, lays.map((l) => str(l.color))),
    concept('PANAL', ImportConcept.PANEL, lays.map((l) => str(l.panel))),
    concept('SIZE', ImportConcept.SIZE_RATIO, lays.map((l) => str(l.sizeRatio))),
    concept('Layers', ImportConcept.LAYERS, lays.map((l) => str(l.layers))),
    concept('Total Length', ImportConcept.TOTAL_LENGTH, lays.map((l) => str(l.totalLengthM))),
    concept('NEST', ImportConcept.NEST_PCS, lays.map((l) => str(l.nestPcs))),
    concept('Marker Length', ImportConcept.MARKER_LENGTH, lays.map((l) => str(l.markerLengthM))),
    concept('EFF%', ImportConcept.EFFICIENCY, lays.map((l) => str(l.efficiencyPct))),
  ].map((c, i) => ({ ...c, index: i }));

  issues.unshift({
    level: 'INFO', field: null, sheet: age.sheetName, cell: null,
    message: `Recognised the factory laying sheet: ${lays.length} lay${lays.length === 1 ? '' : 's'}`
      + (colourLays > 0 ? `, ${colourLays} lay${colourLays === 1 ? '' : 's'} by colour and size from the cut tables` : '')
      + (panelRows > 0 ? `, ${panelRows} panel row${panelRows === 1 ? '' : 's'} by colour` : '')
      + (age.fabricSummary.length > 0 ? `, fabric for ${age.fabricSummary.length} fabric/colour${age.fabricSummary.length === 1 ? '' : 's'}` : '')
      + (age.header.poNumber ? `, PO ${age.header.poNumber}` : '') + '.',
  });
  if (repeated > 0) {
    issues.push({
      level: 'INFO', field: null, sheet: age.sheetName, cell: null,
      message: `The sheet's second set of cut tables repeats ${repeated} colour row${repeated === 1 ? '' : 's'} of the first; ${repeated === 1 ? 'it is' : 'they are'} read once.`,
    });
  }
  const laySum = lays.reduce((a, l) => a + (l.total ?? 0), 0);
  if (age.totals?.total != null && laySum !== age.totals.total) {
    issues.push({
      level: 'WARNING', field: null, sheet: age.sheetName, cell: null,
      message: `The sheet's TOTAL row says ${age.totals.total} pieces, but its lays add up to ${laySum}. Check the sheet before importing.`,
    });
  }
  if (lays.length === 0) {
    issues.push({ level: 'WARNING', field: null, sheet: age.sheetName, cell: null, message: 'The lay table was found but holds no lays.' });
  }

  return {
    analysis: {
      sheetName: age.sheetName, headerRowIndex: age.headerRow, columns,
      readiness: assessMapping(columns, LAYING_ESSENTIALS), candidateSheets, rowsDetected: rows.length,
    },
    rows, issues,
    detectedPoNumbers: age.header.poNumber ? [age.header.poNumber] : [],
    extras: {
      layout: 'AGE', sizes: age.sizes, header: age.header, requirement: age.requirement, totals: age.totals,
      variance: age.variance, signatures: age.signatures, fabricSummary: age.fabricSummary, panelTables: age.panelTables,
      colourTables: age.colourTables, fabricLines: age.fabricLines,
    },
  };
}

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[,\s$%]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toText(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function emptyResult(candidateSheets: Array<{ name: string; rows: number }>, issues: ImportIssue[]): LayingExtractionResult {
  return {
    analysis: {
      sheetName: '', headerRowIndex: 0, columns: [],
      readiness: assessMapping([], LAYING_ESSENTIALS),
      candidateSheets, rowsDetected: 0,
    },
    rows: [], issues, detectedPoNumbers: [],
  };
}

export async function extractLayingMarking(
  buffer: Buffer,
  options: {
    sheetName?: string;
    overrides?: Record<number, ImportConcept>;
    savedMapping?: Record<string, ImportConcept>;
  } = {},
): Promise<LayingExtractionResult> {
  /**
   * A laying sheet exported as CSV is still a laying sheet.
   *
   * Everything past this line works on rows and columns and does not care which
   * kind of file they came out of — the order importer has read CSV the same
   * way all along. Refusing it here meant a factory that exports from its
   * cutting system rather than Excel could not import at all.
   */
  const wb = detectFileKind(buffer) === 'csv'
    ? await readCsvWorkbook(buffer)
    : await openWorkbook(buffer);

  const issues: ImportIssue[] = [];

  // The factory's own layout first. Column overrides do not apply to it: every
  // column is known, and the review screen shows them as recognised.
  const ageSheets = wb.worksheets
    .map((ws) => ({ ws, age: readAgeLayingSheet(ws) }))
    .filter((x): x is { ws: ExcelJS.Worksheet; age: AgeLayingSheet } => x.age != null && (x.age.lays.length > 0 || x.age.panelTables.length > 0));
  const agePick = options.sheetName
    ? ageSheets.find((x) => x.ws.name === options.sheetName)
    : [...ageSheets].sort((a, b) => b.age.lays.length - a.age.lays.length)[0];
  if (agePick) {
    return fromAgeSheet(agePick.age, ageSheets.map((x) => ({ name: x.ws.name, rows: x.age.lays.length })));
  }

  // For each sheet, try every plausible header row and keep whichever
  // matches the most laying/marking concepts — not `readSheetTable`'s
  // built-in choice, which judges by order-matrix concepts instead (see the
  // file header comment). Then rank sheets the same way for cross-sheet
  // selection.
  const candidates: Array<{ table: SheetTable; columns: ColumnAnalysis[]; matched: number }> = [];
  for (const sheet of wb.worksheets) {
    let best: { table: SheetTable; columns: ColumnAnalysis[]; matched: number } | null = null;
    for (const headerRowIndex of findHeaderCandidates(sheet).slice(0, 5)) {
      const table = readTableAt(sheet, headerRowIndex);
      if (!table) continue;
      const columns = analyseColumns(table.headers, table.rows, {}, LAYING_CONCEPTS);
      const matched = columns.filter((c) => c.concept !== ImportConcept.IGNORE && c.confidence >= 0.6).length;
      if (!best || matched > best.matched) best = { table, columns, matched };
    }
    if (best) candidates.push(best);
  }
  candidates.sort((a, b) => b.matched - a.matched);
  const candidateSheets = candidates.map((c) => ({ name: c.table.sheetName, rows: c.table.rows.length }));

  const chosen = options.sheetName
    ? candidates.find((c) => c.table.sheetName === options.sheetName)
    : candidates[0];

  // Fewer than two matched concepts means this sheet is not a laying table —
  // it just happens to contain a plausible-looking header row.
  if (!chosen || chosen.matched < 2) {
    issues.push({
      // A warning, not a refusal. Laying sheets are drawn by hand and no two
      // factories lay them out the same way, so "I could not recognise this
      // one" is a statement about the reader, not a fault in the file. The
      // review screen lets the columns be assigned by hand, and the import
      // still completes with whatever was understood.
      level: 'WARNING', field: null, sheet: null, cell: null,
      message:
        'No Laying & Marking table was recognised automatically. The importer looks for a header row with ' +
        'columns such as Fabric, Layers, Marker Length or Marker No. Assign the columns on the review screen, ' +
        'or import anyway and enter the lays on the order.',
    });
    return emptyResult(candidateSheets, issues);
  }

  const { table } = chosen;
  let columns = options.savedMapping
    ? analyseColumns(table.headers, table.rows, options.savedMapping, LAYING_CONCEPTS)
    : chosen.columns;

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

  const byConcept = new Map<ImportConcept, number>();
  for (const c of columns) if (c.concept !== ImportConcept.IGNORE) byConcept.set(c.concept, c.index);
  const cellAt = (row: readonly unknown[], concept: ImportConcept): unknown => {
    const idx = byConcept.get(concept);
    return idx == null ? null : row[idx];
  };

  const rows: LayingRow[] = [];
  const poNumbers = new Set<string>();
  const fractionalLayers: Array<{ rowNumber: number; read: number; kept: number }> = [];

  for (const row of table.rows) {
    const layersRead = toNumber(cellAt(row, ImportConcept.LAYERS));
    // A lay is a whole number of plies and the Marker table stores an
    // integer, so a fractional count (139.5) is rounded here — where the
    // review screen shows it and a warning names the row — rather than
    // truncated silently by the database at commit.
    const layers = layersRead == null ? null : Math.round(layersRead);
    const markerLengthM = toNumber(cellAt(row, ImportConcept.MARKER_LENGTH));
    const fabricName = toText(cellAt(row, ImportConcept.FABRIC))
      ?? toText(cellAt(row, ImportConcept.MATERIAL));
    // A row with none of the essentials is a blank or trailing row, not a lay.
    if (layers == null && markerLengthM == null && fabricName == null) continue;

    const po = toText(cellAt(row, ImportConcept.PO_NUMBER));
    if (po) poNumbers.add(po);

    if (layersRead != null && layers !== layersRead) {
      fractionalLayers.push({ rowNumber: rows.length + 1, read: layersRead, kept: layers! });
    }

    rows.push({
      rowNumber: rows.length + 1,
      markerNumber: toText(cellAt(row, ImportConcept.MARKER_NUMBER)),
      fabricName,
      fabricColor: toText(cellAt(row, ImportConcept.COLOR)),
      panel: toText(cellAt(row, ImportConcept.PANEL)) ?? 'ALL',
      sizeRatio: toText(cellAt(row, ImportConcept.SIZE_RATIO)),
      layers, markerLengthM,
      markerWidthM: toNumber(cellAt(row, ImportConcept.MARKER_WIDTH)),
      totalLengthM: toNumber(cellAt(row, ImportConcept.TOTAL_LENGTH)),
      nestPcs: toNumber(cellAt(row, ImportConcept.NEST_PCS)),
      efficiencyPct: toNumber(cellAt(row, ImportConcept.EFFICIENCY)),
      wastagePct: toNumber(cellAt(row, ImportConcept.WASTAGE)),
      fabricConsumptionM: toNumber(cellAt(row, ImportConcept.FABRIC_CONSUMPTION)),
      cutDate: safeDate(cellAt(row, ImportConcept.CUT_DATE)),
      cutByName: toText(cellAt(row, ImportConcept.RESPONSIBLE_PERSON)),
      poNumber: po,
      maxLayer: null,
      kind: 'LAY',
    });
  }

  const readiness = assessMapping(columns, LAYING_ESSENTIALS);
  if (!readiness.ready) {
    issues.push({
      // Also a warning. A sheet that states a size ratio and a layer count but
      // no marker length is still worth importing — the committer defaults
      // what is absent, and the rest of the lay plan is real.
      level: 'WARNING', field: null, sheet: table.sheetName, cell: null,
      message: `These columns were not recognised: ${readiness.missing.map((c) => CONCEPT_META[c].label).join(', ')}. `
        + `Assign them below if the sheet has them under different headings, or import without them.`,
    });
  }
  if (rows.length === 0 && readiness.ready) {
    issues.push({
      level: 'WARNING', field: null, sheet: table.sheetName, cell: null,
      message: 'The columns were identified but no data rows were found under them.',
    });
  }
  for (const f of fractionalLayers) {
    issues.push({
      level: 'WARNING', field: 'layers', sheet: table.sheetName, cell: `data row ${f.rowNumber}`,
      message: `Data row ${f.rowNumber}: layer count ${f.read} is not a whole number; it will be imported as ${f.kept}.`,
    });
  }
  for (const row of rows) {
    if (row.layers != null && row.layers <= 0) {
      issues.push({
        level: 'WARNING', field: 'layers', sheet: table.sheetName, cell: `data row ${row.rowNumber}`,
        message: `Data row ${row.rowNumber}: layer count is ${row.layers}, which is not a usable value.`,
      });
    }
    if (row.markerLengthM != null && row.markerLengthM <= 0) {
      issues.push({
        level: 'WARNING', field: 'markerLengthM', sheet: table.sheetName, cell: `data row ${row.rowNumber}`,
        message: `Data row ${row.rowNumber}: marker length is ${row.markerLengthM}, which is not a usable value.`,
      });
    }
  }

  return {
    analysis: {
      sheetName: table.sheetName, headerRowIndex: table.headerRowIndex, columns,
      readiness, candidateSheets, rowsDetected: rows.length,
    },
    rows, issues, detectedPoNumbers: [...poNumbers],
  };
}
