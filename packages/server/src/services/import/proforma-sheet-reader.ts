/**
 * The proforma's own invoice sheet, read by its layout.
 *
 * The factory's proforma (and OpsFlow's export of it) is a title block — the
 * title "… Proforma invoice No.64", Date, Shipment From/To — then a table
 * headed Qty | PO# | Part No. | Description | … | UNIT Price in $ | Total
 * Price in $, one line per style, closed by a Total row. The general table
 * reader took "Shipment From | Egypt" for the heading and read nothing, so
 * importing a proforma on the order's own step gave an empty draft.
 */

import ExcelJS from 'exceljs';
import { cellText } from './extractor.js';
import { loadWorkbook } from './open-workbook.js';
import { evaluateCell } from './formula-eval.js';
import type { ExtractedLineItem } from './extractor.js';

export interface ProformaSheet {
  number: string | null;
  date: Date | null;
  lines: ExtractedLineItem[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#$]+/g, ' ').trim();

function value(ws: ExcelJS.Worksheet, cell: ExcelJS.Cell): unknown {
  const v = cell.value as unknown;
  if (v && typeof v === 'object' && ('formula' in (v as object) || 'sharedFormula' in (v as object))) {
    const r = (v as { result?: unknown }).result;
    if (r != null && typeof r !== 'object') return r;
    return evaluateCell(ws, cell)?.value ?? null;
  }
  if (v && typeof v === 'object' && 'richText' in (v as object)) return cellText(v as never);
  return v;
}

const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const n = Number(v.replace(/[,$\s]/g, '')); return v.trim() && Number.isFinite(n) ? n : null; }
  return null;
};

export async function readProformaSheet(buffer: Buffer, sheetName: string): Promise<ProformaSheet | null> {
  const wb = new ExcelJS.Workbook();
  try { await loadWorkbook(wb, buffer); } catch { return null; }
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return null;
  const last = Math.min(ws.rowCount, 400);
  const text = (r: number, c: number) => String(cellText(value(ws, ws.getRow(r).getCell(c)) as never) ?? '').trim();

  let number: string | null = null;
  let date: Date | null = null;
  let header = -1;
  const cols: Record<string, number> = {};
  for (let r = 1; r <= last && header < 0; r++) {
    for (let c = 1; c <= Math.min(ws.columnCount, 30); c++) {
      const t = text(r, c);
      if (!t) continue;
      const no = /pro\s*-?\s*forma\s+invoice\s*(?:no\.?|number|#)\s*:?\s*([A-Za-z0-9-]+)/i.exec(t);
      if (no && !number) number = no[1]!;
      if (/^date\s*:?$/i.test(t) && !date) {
        for (let k = c + 1; k <= c + 3; k++) {
          const v = value(ws, ws.getRow(r).getCell(k));
          if (v instanceof Date) { date = v; break; }
        }
      }
    }
    // The table's heading: quantity, a description and a price on one row.
    const heads = new Map<number, string>();
    for (let c = 1; c <= Math.min(ws.columnCount, 30); c++) { const t = norm(text(r, c)); if (t) heads.set(c, t); }
    const find = (re: RegExp) => [...heads].find(([, t]) => re.test(t))?.[0];
    const qty = find(/^(qty|quantity|pcs)$/);
    const desc = find(/^(description|discription|descripton|desc|style|item)$/);
    const price = find(/unit\s*price/);
    if (qty != null && desc != null && price != null) {
      header = r;
      Object.assign(cols, { qty, desc, price });
      const total = find(/total\s*price|amount/); if (total != null) cols.total = total;
      const part = find(/^part\s*no/); if (part != null) cols.part = part;
      const po = find(/^po\s*#?$|^po\s*no/); if (po != null) cols.po = po;
    }
  }
  if (header < 0) return { number, date, lines: [] };

  const lines: ExtractedLineItem[] = [];
  for (let r = header + 1; r <= last; r++) {
    const description = text(r, cols.desc!);
    if (/^(total|sub\s*total|grand\s*total)\b/i.test(description)) break;
    const quantity = asNumber(value(ws, ws.getRow(r).getCell(cols.qty!)));
    const unitPrice = asNumber(value(ws, ws.getRow(r).getCell(cols.price!)));
    if (!description && quantity == null) continue;
    if (!description && quantity != null && unitPrice == null) break;
    const ref = [cols.po ? text(r, cols.po) : '', cols.part ? text(r, cols.part) : ''].filter(Boolean).join(' · ');
    lines.push({
      description: description ? (ref ? `${description} (${ref})` : description) : null,
      quantity, unit: 'PCS', unitPrice, rowNumber: r,
    } as ExtractedLineItem);
  }
  return { number, date, lines };
}
