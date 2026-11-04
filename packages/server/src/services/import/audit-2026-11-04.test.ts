/**
 * Regressions from the whole-system audit of 2026-11-04: ways a file could put
 * a wrong number into an order without a word said. Each case is the file as a
 * customer or the factory writes it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { extractTabular } from './tabular-extractor.js';
import { mergeMatrixAxes } from './committer.js';
import { extractWorkbook } from './extractor.js';
import { AGE_ORDER_V1 } from './profiles.js';
import { readPoLines, poLinesToOrder } from './po-lines.js';
import { evaluateCell } from './formula-eval.js';

async function grid(rows: unknown[][], shape?: (ws: ExcelJS.Worksheet) => void) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Order');
  for (const r of rows) ws.addRow(r);
  shape?.(ws);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const res = await extractTabular(buf, { fileName: 'x.xlsx' });
  const m = res.matrices[0];
  return { rows: m ? mergeMatrixAxes(m).rows : [], issues: res.issues };
}

describe('size grids that used to double or merge quantities', () => {
  test('the same colour under two styles is two rows, as the long layout reads it', async () => {
    const r = await grid([
      ['PO Number', 'PO-1'], [],
      ['Style', 'Colour', 'S', 'M', 'L', 'Total'],
      ['ST-100', 'Navy', 10, 20, 30, 60],
      ['ST-200', 'Navy', 5, 5, 5, 15],
      ['Total', '', 15, 25, 35, 75],
    ]);
    assert.deepEqual(r.rows.map((x) => [x.color, x.total]), [['ST-100 — Navy', 60], ['ST-200 — Navy', 15]]);
  });

  test("Excel's Data→Subtotal rows (\"Navy Total\") are totals, not colours", async () => {
    const r = await grid([
      ['PO Number', 'PO-1'], [],
      ['Colour', 'S', 'M', 'L'],
      ['Navy', 10, 20, 30],
      ['Navy Total', 10, 20, 30],
      ['Red', 1, 1, 1],
      ['Red Total', 1, 1, 1],
      ['Grand Total', 11, 21, 31],
    ]);
    assert.deepEqual(r.rows.map((x) => [x.color, x.total]), [['Navy', 60], ['Red', 3]]);
  });

  test('a hidden size column is a size taken out of the order', async () => {
    const r = await grid([
      ['PO Number', 'PO-1'], [],
      ['Colour', 'S', 'M', 'L', 'XL', 'Total'],
      ['Navy', 10, 20, 30, 40, 60],
      ['Red', 5, 5, 5, 5, 15],
      ['Total', '', 15, 25, 35, 75],
    ], (ws) => { ws.getColumn(5).hidden = true; });
    assert.deepEqual(r.rows.map((x) => [x.color, x.total]), [['Navy', 60], ['Red', 15]]);
    assert.ok(!r.rows.some((x) => 'XL' in x.cells));
  });
});

describe("the AGE workbook's cut percentage and totals row", () => {
  async function build(cut: unknown, totalsLabel = 'Totals') {
    const wb = new ExcelJS.Workbook();
    for (const name of AGE_ORDER_V1.signature.names) wb.addWorksheet(name);
    const od = wb.getWorksheet('Order Details_Coordinator')!;
    od.getCell('C7').value = 'Po No'; od.getCell('D7').value = '13506';
    od.getCell('C18').value = 'Cut Percentage'; od.getCell('D18').value = cut as ExcelJS.CellValue;
    const mo = wb.getWorksheet('Main Order_Factory.Manger')!;
    mo.getCell('C22').value = 'Color'; ['S', 'M'].forEach((s, i) => { mo.getCell(22, 4 + i).value = s; }); mo.getCell(22, 6).value = 'Total';
    mo.getCell(23, 3).value = 'Navy'; mo.getCell(23, 4).value = 10; mo.getCell(23, 5).value = 20; mo.getCell(23, 6).value = 30;
    mo.getCell(24, 3).value = totalsLabel; mo.getCell(24, 4).value = 10; mo.getCell(24, 5).value = 20; mo.getCell(24, 6).value = 30;
    return extractWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
  }
  test('"3%" typed as text is 3%', async () => {
    assert.equal((await build('3%')).fields.cutPercentage, 0.03);
    assert.equal((await build('3 %')).fields.cutPercentage, 0.03);
  });
  test('a cell holding 1 is not a 100% allowance: not used, and said', async () => {
    const r = await build(1);
    assert.equal(r.fields.cutPercentage, null);
    assert.ok(r.issues.some((i) => i.field === 'cutPercentage' && i.level === 'WARNING'));
    assert.equal((await build(0.8)).fields.cutPercentage, null);
    assert.equal((await build(0.05)).fields.cutPercentage, 0.05);
    assert.equal((await build(5)).fields.cutPercentage, 0.05);
  });
  test('a totals row labelled "Total" or "Grand Total" ends the grid as "Totals" does', async () => {
    for (const label of ['Total', 'TOTAL', 'Grand Total']) {
      const rows = (await build(0.05, label)).matrices.find((m) => m.ledger === 'ORDER')?.rows ?? [];
      assert.deepEqual(rows.map((x) => x.color), ['Navy'], label);
    }
  });
});

describe('PDF purchase-order lines', () => {
  test('a line priced per dozen is twelve pieces at a twelfth of the price', () => {
    const L = (t: string) => t.split('|').map((x, i) => ({ text: x.trim(), x: i * 50, end: i * 50 + 40 }));
    const lines = [L('1 | POLO SHIRT | 10 | DZ | 48.00 | 480.00'), L('NAVY LARGE')];
    const po = poLinesToOrder(readPoLines(lines, new Set(), true));
    assert.equal(po.totalQty, 120);
    assert.equal(po.pricePerPiece, 4);
    assert.equal(po.totalValue, 480);
    assert.equal(po.notes.length, 1);
  });
});

describe('the formula calculator', () => {
  const sheet = () => new ExcelJS.Workbook().addWorksheet('P');
  test('SUBTOTAL over block subtotals skips them, as Excel does', () => {
    const ws = sheet();
    ws.getCell('A1').value = 10; ws.getCell('A2').value = 20;
    ws.getCell('A3').value = { formula: 'SUBTOTAL(9,A1:A2)' } as ExcelJS.CellValue;
    ws.getCell('A4').value = 5;
    ws.getCell('A5').value = { formula: 'SUBTOTAL(9,A4:A4)' } as ExcelJS.CellValue;
    ws.getCell('A6').value = { formula: 'SUBTOTAL(9,A1:A5)' } as ExcelJS.CellValue;
    assert.deepEqual(evaluateCell(ws, ws.getCell('A6')), { value: 35 });
  });
  test('a wildcard criterion is beyond the calculator, not a literal that matches nothing', () => {
    const ws = sheet();
    ws.getCell('B1').value = 'Navy-1'; ws.getCell('B2').value = 'Navy-2'; ws.getCell('C1').value = 3; ws.getCell('C2').value = 4;
    ws.getCell('B3').value = { formula: 'SUMIF(B1:B2,"Navy*",C1:C2)' } as ExcelJS.CellValue;
    assert.equal(evaluateCell(ws, ws.getCell('B3')), undefined);
  });
});
