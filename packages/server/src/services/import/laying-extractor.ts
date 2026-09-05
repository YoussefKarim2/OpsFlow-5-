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

const LAYING_CONCEPTS = new Set<ImportConcept>([
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
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const issues: ImportIssue[] = [];

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
      level: 'ERROR', field: null, sheet: null, cell: null,
      message:
        'No Laying & Marking table could be found in this file. The importer looks for a header row with ' +
        'columns such as Fabric, Layers, Marker Length or Marker No. — check the sheet has those headings.',
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

  for (const row of table.rows) {
    const layers = toNumber(cellAt(row, ImportConcept.LAYERS));
    const markerLengthM = toNumber(cellAt(row, ImportConcept.MARKER_LENGTH));
    const fabricName = toText(cellAt(row, ImportConcept.FABRIC));
    // A row with none of the essentials is a blank or trailing row, not a lay.
    if (layers == null && markerLengthM == null && fabricName == null) continue;

    const po = toText(cellAt(row, ImportConcept.PO_NUMBER));
    if (po) poNumbers.add(po);

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
    });
  }

  const readiness = assessMapping(columns, LAYING_ESSENTIALS);
  if (!readiness.ready) {
    issues.push({
      level: 'ERROR', field: null, sheet: table.sheetName, cell: null,
      message: `Missing required columns: ${readiness.missing.map((c) => CONCEPT_META[c].label).join(', ')}. Map them below and try again.`,
    });
  }
  if (rows.length === 0 && readiness.ready) {
    issues.push({
      level: 'WARNING', field: null, sheet: table.sheetName, cell: null,
      message: 'The columns were identified but no data rows were found under them.',
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
