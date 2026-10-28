/**
 * The factory proforma sheet as an Excel workbook, laid out as the factory's
 * own file ("Proforma No. 64 Spring 27.xlsx"): an `invoice` sheet with one
 * row per style, then one sheet per style with its colour × size grid.
 *
 * The figures are live formulas, as in the factory's file: each style's
 * quantity is its sheet's Grand Total, Total = Qty × Unit price, cartons =
 * ROUNDUP(Qty ÷ pieces per carton), % of container = cartons ÷ the container
 * cell, ETA = ETD + lead days, and the totals row sums each column.
 */

import ExcelJS from 'exceljs';
import {
  InvoiceLineKind, SHEET_DEFAULTS, buildSheet, sheetRowKey, styleText, stylesOf,
  type InvoiceDto, type SheetRow,
} from '@opsflow/shared';
import { productLabel, type BuildOrder } from './invoice-service.js';

/** One style's colour × size grid, from the order's ORDER quantities. */
interface StyleGrid { sizes: string[]; rows: Array<{ colour: string; cells: number[] }>; total: number; shipDate: Date | null }

/**
 * Each style's grid, keyed as the sheet rows are, from the orders' own
 * quantities: the colours of one style, in the order's colour order.
 */
export function styleGrids(orders: BuildOrder[], manyOrders: boolean): Map<string, StyleGrid> {
  // Each style's colours with their pieces by size name, in the order's colour order.
  const pending = new Map<string, { sizeOrder: string[]; rows: Array<{ colour: string; bySize: Map<string, number> }>; shipDate: Date | null }>();
  for (const order of orders) {
    const colours = [...order.colors].sort((a, b) => a.position - b.position)
      .filter((c) => order.orderCells.some((x) => x.orderColorId === c.id && x.qty > 0));
    const texts = colours.map((c) => styleText(productLabel(order, c.id), order.orderName));
    const styles = stylesOf(texts);
    const distinct = new Set(styles.map((s, i) => (s ?? texts[i]!).toLowerCase()));
    const wholeOrder = distinct.size <= 1 || styles.every((s) => s == null);
    const sizeName = new Map(order.sizes.map((s) => [s.id, s.name]));
    colours.forEach((c, i) => {
      const style = wholeOrder ? order.orderName : styles[i] ?? texts[i]!;
      // The colour as the grid lists it: the text after the style's name.
      const rest = wholeOrder ? c.name : texts[i]!.slice(style.length).replace(/^\s*—?\s*/, '').trim();
      const key = sheetRowKey(style, order.poNumber, manyOrders);
      const g = pending.get(key) ?? { sizeOrder: [], rows: [], shipDate: order.promisedShippingDate };
      for (const s of order.sizes) if (!g.sizeOrder.includes(s.name)) g.sizeOrder.push(s.name);
      const bySize = new Map<string, number>();
      for (const x of order.orderCells) {
        if (x.orderColorId !== c.id || x.qty <= 0) continue;
        const name = sizeName.get(x.orderSizeId) ?? '';
        bySize.set(name, (bySize.get(name) ?? 0) + x.qty);
      }
      g.rows.push({ colour: rest || c.name, bySize });
      pending.set(key, g);
    });
  }
  // The style's own sizes only, as the factory's sheet has them: a style
  // sold in youth sizes does not list the adult ones another style uses.
  const out = new Map<string, StyleGrid>();
  for (const [key, g] of pending) {
    const sizes = g.sizeOrder.filter((s) => g.rows.some((r) => (r.bySize.get(s) ?? 0) > 0));
    const rows = g.rows.map((r) => ({ colour: r.colour, cells: sizes.map((s) => r.bySize.get(s) ?? 0) }));
    out.set(key, { sizes, rows, total: rows.reduce((a, r) => a + r.cells.reduce((x, q) => x + q, 0), 0), shipDate: g.shipDate });
  }
  return out;
}

const col = (n: number): string => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};
const day = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
/** "84873" is written as a number, as the factory's sheet has it; "IMPORT-…" stays text. */
const numberish = (s: string): string | number => (/^\d{1,15}$/.test(s) ? Number(s) : s);
const sheetName = (s: string) => s.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
const quote = (name: string) => `'${name.replace(/'/g, "''")}'`;

const ACCOUNTING_USD = '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)';
const ACCOUNTING_INT = '_(* #,##0_);_(* (#,##0);_(* "-"??_);_(@_)';
const DAY_FMT = '[$-409]d-mmm-yy;@';
const thin = { style: 'thin' as const };
const medium = { style: 'medium' as const };

export async function proformaSheetWorkbook(inv: InvoiceDto, orders: BuildOrder[]): Promise<Buffer> {
  const s = inv.sheet ?? {};
  const many = inv.orders.length > 1;
  const { rows } = buildSheet(inv.lines, inv.orders, s);
  const grids = styleGrids(orders, many);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OpsFlow';
  const ws = wb.addWorksheet('invoice', {
    pageSetup: {
      paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1,
      margins: { left: 0.17, right: 0.17, top: 0.42, bottom: 0.31, header: 0.3, footer: 0.3 },
    },
    views: [{ zoomScale: 55, zoomScaleNormal: 100 }],
  });
  [17.66, 20.83, 21.5, 49.33, 26.66, 8.83, 8.66, 16.83, 9.16, 19.5, 25.16, 19.5].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const font20 = { name: 'Arial', size: 20 };
  const bold20 = { name: 'Arial', size: 20, bold: true };
  const label = (r: number, text: string, value: ExcelJS.CellValue, opts: { numFmt?: string; merge?: boolean } = {}) => {
    ws.getRow(r).height = 27;
    ws.getCell(`A${r}`).value = text;
    ws.getCell(`A${r}`).font = font20;
    const c = ws.getCell(`C${r}`);
    c.value = value ?? null;
    c.font = font20;
    c.alignment = { horizontal: 'left', wrapText: !!opts.merge };
    if (opts.numFmt) c.numFmt = opts.numFmt;
    if (opts.merge) ws.mergeCells(`C${r}:D${r}`);
  };

  // ── Title ────────────────────────────────────────────────────────────────
  const title = (n: number, text: string) => {
    ws.mergeCells(`A${n}:L${n}`);
    const c = ws.getCell(`A${n}`);
    c.value = text;
    c.font = { name: 'Arial', size: 22, bold: true };
    c.alignment = { horizontal: 'center' };
    ws.getRow(n).height = 33.75;
  };
  title(3, s.title?.trim() || `${inv.order.clientName} Proforma invoice No.${inv.number}`);
  title(4, s.statement ?? SHEET_DEFAULTS.statement);

  // ── Shipment block ───────────────────────────────────────────────────────
  const address = (inv.billToAddress ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  label(6, 'Shipment From', s.shipmentFrom ?? SHEET_DEFAULTS.shipmentFrom);
  label(7, 'Date :', day(inv.date), { numFmt: DAY_FMT, merge: true });
  label(8, 'Shipment To', inv.billTo);
  label(9, 'Address :', address[0] ?? '');
  label(10, '', address[1] ?? '');
  label(11, '', address.slice(2).join(', '));
  label(12, 'container', numberish(s.container ?? SHEET_DEFAULTS.container));
  label(13, 'On Board Date:', day(s.onBoardDate), { numFmt: DAY_FMT, merge: true });
  label(14, 'ETD:', day(s.etd), { numFmt: DAY_FMT, merge: true });
  const lead = s.leadDays ?? SHEET_DEFAULTS.leadDays;
  label(15, 'ETA:', s.etd ? { formula: `C14+${lead}` } : null, { numFmt: DAY_FMT, merge: true });
  ws.getCell('G15').value = `Based on ${lead} days lead time`;
  ws.getCell('G15').font = font20;
  label(16, 'Shipment From', s.portFrom ?? '');
  label(17, 'Shipment To', s.portTo ?? '');
  label(18, 'Consolidating vendor:', s.consolidatingVendor ?? '');

  // ── The table ────────────────────────────────────────────────────────────
  const HEAD = 21, FIRST = 22, LAST = FIRST + Math.max(rows.length, 1) - 1, TOTAL = LAST + 1;
  label(19, 'No. of cartons', {
    formula: `H${TOTAL}&" carton NW: "&G${TOTAL}&" KG. GW: "&F${TOTAL}&" KG. Size "&"${(s.cartonSize ?? '').replace(/"/g, '""')}"`,
  });
  const box = ws.getCell('L20');
  box.value = s.cartonsPerContainer ?? SHEET_DEFAULTS.cartonsPerContainer;
  box.font = { name: 'Arial', size: 12 };
  box.note = 'Cartons one container holds: % of container = cartons ÷ this cell.';
  ws.getRow(20).height = 17;

  const heads = ['Qty', 'PO#', 'Part No.', 'Description', 'HTS Code', 'G.W', 'N.W', 'No. Of Cartons', 'Unit', 'UNIT Price in $', 'Total Price in $', '%ge of container'];
  const headRow = ws.getRow(HEAD);
  headRow.height = 61.5;
  heads.forEach((h, i) => {
    const c = headRow.getCell(i + 1);
    c.value = h;
    c.font = { name: 'Arial', size: 18, bold: true };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { top: medium, left: medium, bottom: medium, right: medium };
  });

  const usedNames = new Set<string>(['invoice']);
  const styleSheets: Array<{ row: SheetRow; name: string; grid: StyleGrid | undefined }> = rows.map((row) => {
    const base = sheetName(`PO${row.po} ${row.description}`) || 'Style';
    let name = base;
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = sheetName(`${base.slice(0, 27)} (${n})`);
    usedNames.add(name.toLowerCase());
    return { row, name, grid: grids.get(row.key) };
  });

  styleSheets.forEach(({ row, name, grid }, i) => {
    const r = FIRST + i;
    const x = ws.getRow(r);
    x.height = 25;
    const gtCell = grid ? `${col(grid.sizes.length + 2)}${6 + grid.rows.length}` : null;
    // The quantity is the style sheet's Grand Total, as in the factory's file,
    // when that sheet holds exactly what the document bills.
    const qty: ExcelJS.CellValue = grid && gtCell && grid.total === row.qty ? { formula: `${quote(name)}!${gtCell}`, result: row.qty } : row.qty;
    const values: ExcelJS.CellValue[] = [
      qty, numberish(row.po), row.partNo, row.description, numberish(row.hts), row.gw, row.nw,
      row.cartonsTyped ? row.cartons : { formula: `ROUNDUP(A${r}/${row.perCarton},0)`, result: row.cartons },
      row.unit, row.unitPrice,
      // A style of several rates has its own exact total; one rate multiplies out.
      row.mixedRates || row.unitPrice == null ? row.total : { formula: `A${r}*J${r}`, result: row.total ?? undefined },
      { formula: `H${r}/$L$20`, result: row.containerShare ?? undefined },
    ];
    values.forEach((v, j) => {
      const c = x.getCell(j + 1);
      c.value = v ?? null;
      c.font = { name: 'Arial', size: 18, bold: true };
      c.alignment = { horizontal: j === 3 ? 'left' : 'center', vertical: 'middle', wrapText: j >= 9 };
      c.border = { top: thin, left: thin, bottom: thin, right: thin };
    });
    x.getCell(1).numFmt = ACCOUNTING_INT;
    x.getCell(5).numFmt = '0';
    x.getCell(8).numFmt = '0';
    x.getCell(10).numFmt = ACCOUNTING_USD;
    x.getCell(11).numFmt = ACCOUNTING_USD;
    x.getCell(12).numFmt = '0%';
  });

  const tot = ws.getRow(TOTAL);
  tot.height = 39;
  const sum = (c: string) => ({ formula: `SUM(${c}${FIRST}:${c}${LAST})` });
  const totals: Array<[number, ExcelJS.CellValue, string?]> = [
    [1, sum('A'), ACCOUNTING_INT], [4, 'Total'], [6, sum('F'), '0.##'], [7, sum('G'), '0.##'],
    [8, sum('H'), '0'], [11, sum('K'), ACCOUNTING_USD], [12, sum('L'), '0%'],
  ];
  for (let j = 1; j <= 12; j++) {
    const c = tot.getCell(j);
    c.font = { name: 'Arial', size: 18, bold: true };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = { top: medium, bottom: medium, left: j === 1 ? medium : thin, right: j === 12 ? medium : thin };
  }
  for (const [j, v, fmt] of totals) { tot.getCell(j).value = v; if (fmt) tot.getCell(j).numFmt = fmt; }
  ws.autoFilter = `A${HEAD}:L${LAST}`;

  // Extras and discounts are not styles: listed under the total, with the amount due.
  let r = TOTAL + 1;
  const extras = inv.lines.filter((l) => l.kind === InvoiceLineKind.EXTRA);
  if (extras.length > 0) {
    for (const e of extras) {
      ws.getCell(`D${r}`).value = e.description;
      ws.getCell(`K${r}`).value = e.amount ?? null;
      ws.getCell(`K${r}`).numFmt = ACCOUNTING_USD;
      for (const a of [`D${r}`, `K${r}`]) ws.getCell(a).font = { name: 'Arial', size: 18, bold: true };
      ws.getRow(r).height = 25;
      r++;
    }
    ws.getCell(`D${r}`).value = 'Amount due';
    ws.getCell(`K${r}`).value = { formula: `K${TOTAL}+SUM(K${TOTAL + 1}:K${r - 1})` };
    ws.getCell(`K${r}`).numFmt = ACCOUNTING_USD;
    for (const a of [`D${r}`, `K${r}`]) ws.getCell(a).font = { name: 'Arial', size: 18, bold: true };
    ws.getRow(r).height = 25;
    r++;
  }

  // ── Exporter, terms, bank, signature ────────────────────────────────────
  const footer = (text: string, value?: string | null, at: 'A' | 'B' = 'A') => {
    ws.getRow(r).height = 27;
    const a = ws.getCell(`${at}${r}`);
    a.value = text;
    a.font = bold20;
    a.alignment = { horizontal: 'left' };
    if (value != null) {
      const c = ws.getCell(`C${r}`);
      c.value = value;
      c.font = bold20;
      c.alignment = { horizontal: 'left' };
    }
    r++;
  };
  r++;
  footer('Name :', s.exporterName ?? inv.seller.name);
  footer('Address :', s.exporterAddress ?? inv.seller.address ?? '');
  footer('QIZ Ref. No. :', s.qizRef ?? inv.seller.qizRef ?? '');
  footer('Destination :', s.destination ?? '');
  footer('Exporter Name :', s.exporterName ?? inv.seller.name);
  r++;
  const terms = (inv.terms ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
  const bank = (inv.bankDetails ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
  if (terms.length > 0 || bank.length > 0) footer('Terms and conditions');
  terms.forEach((t, i) => {
    ws.getRow(r).height = 27;
    ws.getCell(`A${r}`).value = i + 1;
    ws.getCell(`B${r}`).value = t.replace(/^\d+[.)]\s*/, '');
    for (const a of [`A${r}`, `B${r}`]) { ws.getCell(a).font = bold20; ws.getCell(a).alignment = { horizontal: 'left' }; }
    r++;
  });
  for (const b of bank) {
    // "Bank: National Bank of Egypt" prints as the factory's sheet does: label, then ": value".
    const m = /^([^:]{1,40}):\s*(.*)$/.exec(b);
    footer(m ? m[1]!.trim() : b, m ? `: ${m[2]}` : null, 'B');
  }
  r++;
  // The stamp beside the signature, as the factory's sheet places it.
  const stamp = /^data:image\/(png|jpeg);base64,(.+)$/.exec(inv.seller.stampDataUrl ?? '');
  if (stamp) {
    const imageId = wb.addImage({ base64: stamp[2]!, extension: stamp[1] === 'jpeg' ? 'jpeg' : 'png' });
    ws.addImage(imageId, { tl: { col: 4, row: r - 3 }, ext: { width: 200, height: 104 } });
  }
  footer(`For and in behalf of ${s.exporterName ?? inv.seller.name}`);
  const signatory = s.signatory ?? inv.seller.signatory;
  if (signatory) footer(signatory);

  // ── One sheet per style ─────────────────────────────────────────────────
  for (const { row, name, grid } of styleSheets) {
    const st = wb.addWorksheet(name);
    [13.33, 13.66, 13.66, 12, 12, 12, 12, 12, 12, 12, 14.5, 13.33].forEach((w, i) => { st.getColumn(i + 1).width = w; });
    const b12 = { name: 'Arial', size: 12, bold: true };
    const box2 = { top: medium, left: medium, bottom: medium, right: medium };
    const put = (addr: string, v: ExcelJS.CellValue, fmt?: string) => {
      const c = st.getCell(addr);
      c.value = v ?? null;
      c.font = b12;
      c.border = box2;
      c.alignment = { horizontal: 'left' };
      if (fmt) c.numFmt = fmt;
    };
    const sizes = grid?.sizes ?? [];
    const gtCol = col(sizes.length + 2);
    const gtRow = 6 + (grid?.rows.length ?? 0);
    put('A1', 'Style'); st.mergeCells('B1:C1'); put('B1', row.description); st.getCell('B1').alignment = { horizontal: 'center' };
    put('E1', 'Style #'); put('F1', row.partNo);
    put('J1', 'Total Qty'); put('K1', grid ? { formula: `${gtCol}${gtRow}`, result: grid.total } : row.qty, '#,##0');
    put('A3', 'Date'); put('B3', day(inv.date), 'd-mmm-yy');
    put('E3', 'PO #'); put('F3', numberish(row.po)); st.getCell('F3').alignment = { horizontal: 'center' };
    put('J3', 'FOB'); put('K3', grid?.shipDate ?? null, 'd-mmm-yy');
    if (!grid) continue;
    const head = st.getRow(5);
    ['Row Labels', ...sizes, 'Grand Total'].forEach((h, i) => {
      const c = head.getCell(i + 1);
      c.value = h;
      c.font = { name: 'Calibri', size: 11, bold: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
      c.alignment = { horizontal: 'center' };
      c.border = { top: thin, left: thin, bottom: thin, right: thin };
    });
    grid.rows.forEach((g, i) => {
      const rr = st.getRow(6 + i);
      const cells: ExcelJS.CellValue[] = [g.colour, ...g.cells.map((q) => (q > 0 ? q : null)), { formula: `SUM(B${6 + i}:${col(sizes.length + 1)}${6 + i})`, result: g.cells.reduce((a, q) => a + q, 0) }];
      cells.forEach((v, j) => {
        const c = rr.getCell(j + 1);
        c.value = v;
        c.font = { name: 'Calibri', size: 11 };
        c.alignment = { horizontal: 'center' };
        c.border = { top: thin, left: thin, bottom: thin, right: thin };
      });
    });
    const gt = st.getRow(gtRow);
    ['Grand Total', ...sizes.map((_, j) => ({ formula: `SUM(${col(j + 2)}6:${col(j + 2)}${gtRow - 1})` })), { formula: `SUM(${gtCol}6:${gtCol}${gtRow - 1})`, result: grid.total }]
      .forEach((v, j) => {
        const c = gt.getCell(j + 1);
        c.value = v as ExcelJS.CellValue;
        c.font = { name: 'Calibri', size: 11, bold: true };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
        c.alignment = { horizontal: 'center' };
        c.border = { top: thin, left: thin, bottom: thin, right: thin };
      });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
