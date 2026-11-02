/**
 * Regressions from the whole-system audit of 2 November 2026: each test is a
 * file that used to lose pieces, read the wrong thing, or count twice.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { extractTabular } from './tabular-extractor.js';
import { evaluateCell } from './formula-eval.js';
import { readPackingDocument } from './packing-reader.js';
import { readProformaSheet } from './proforma-sheet-reader.js';
import { asPercent } from './percent.js';

async function book(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('the order reader keeps every size, row and visible sheet', () => {
  test('an empty size column does not split the grid', async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('Order');
      ws.addRows([['Colour', 'XS', 'S', 'M', 'L', 'XL'], ['Navy', 7, null, 2, 3, 4], ['Red', 8, null, 5, 6, 1]]);
    });
    const m = (await extractTabular(buf)).matrices[0]!;
    assert.equal(m.computedTotal, 36);
    assert.ok(m.sizes.includes('XS'));
  });

  test('a "TBC" under one size reads as none, warned, and keeps the colour', async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('Order');
      ws.addRows([['Colour', 'S', 'M', 'L', 'XL'], ['Navy', 5, 6, 'TBC', 7], ['Red', 1, 2, 3, 4]]);
    });
    const r = await extractTabular(buf);
    assert.equal(r.matrices[0]!.computedTotal, 28);
    assert.ok(r.issues.some((i) => /TBC/.test(i.message)));
  });

  test('a subtotal does not end the table', async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('Order');
      ws.addRows([['Colour', 'S', 'M', 'L'], ['Navy', 1, 2, 3], ['Subtotal', 1, 2, 3], ['Red', 4, 5, 6], ['Totals', 5, 7, 9]]);
    });
    const m = (await extractTabular(buf)).matrices[0]!;
    assert.deepEqual(m.rows.map((r) => r.color), ['Navy', 'Red']);
    assert.equal(m.computedTotal, 21);
  });

  test('a hidden sheet loses to the visible order; hidden rows are left out and said', async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('Order');
      ws.addRows([['Colour', 'S', 'M'], ['Navy', 1, 2], ['Cancelled', 50, 50], ['Red', 3, 4]]);
      ws.getRow(3).hidden = true;
      const old = wb.addWorksheet('Old season');
      old.state = 'hidden';
      old.addRows([['Colour', 'S', 'M'], ...Array.from({ length: 30 }, (_, i) => [`C${i}`, 100, 100])]);
    });
    const r = await extractTabular(buf);
    assert.equal(r.matrices[0]!.computedTotal, 10);
    assert.ok(r.issues.some((i) => /hidden row/.test(i.message)));
  });

  test('a pivot-table sheet ("Row Labels") is read as colours by size', async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('PO 1');
      ws.addRows([['Row Labels', 'YS', 'YM', 'Grand Total'], ['NAVY', 10, 20, 30], ['RED', 5, 5, 10], ['Grand Total', 15, 25, 40]]);
    });
    assert.equal((await extractTabular(buf)).matrices[0]!.computedTotal, 40);
  });
});

describe('scanning helpers', () => {
  test('a SUM across a merged range counts the merge once', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 5; ws.mergeCells('A1:C1');
    ws.getCell('D1').value = { formula: 'SUM(A1:C1)' } as ExcelJS.CellValue;
    assert.deepEqual(evaluateCell(ws, ws.getCell('D1')), { value: 5 });
  });

  test("a per-carton Total column is not split when the TOTAL row says so", async () => {
    const csv = 'C/No,S,M,Total\n1-2,12,12,24\n3,10,10,20\nTOTAL,,,68\n';
    const r = await readPackingDocument(Buffer.from(csv), 'pl.csv');
    assert.equal(r.totals.pieces, 68);
  });

  test('an efficiency far beyond a percentage is left out, not a failed import', () => {
    assert.equal(asPercent(0.83), 83);
    assert.equal(asPercent(12345), null);
  });

  test("the proforma's own sheet: number, date and one line per style", async () => {
    const buf = await book((wb) => {
      const ws = wb.addWorksheet('invoice');
      ws.getCell('A3').value = 'Xara Proforma invoice No.64 on 21 Oct. 26';
      ws.getCell('A6').value = 'Shipment From'; ws.getCell('C6').value = 'Egypt';
      ws.getCell('A7').value = 'Date :'; ws.getCell('C7').value = new Date(Date.UTC(2026, 9, 21));
      ws.getRow(21).values = ['Qty', 'PO#', 'Part No.', 'Discription', 'HTS Code', 'G.W', 'N.W', 'No. Of Cartons', 'Unit', 'UNIT Price in $', 'Total Price in $'];
      ws.getRow(22).values = [1092, 84873, 'XRA-1003', 'Tranmmer Shirt', 6109900000, null, null, 9.1, 'pce', 3, 3276];
      ws.getRow(23).values = [624, 84880, 'XRA-1051', 'Training Bib', 6109900000, null, null, 5.2, 'pce', 2.7, 1684.8];
      ws.getRow(24).values = [1716, null, null, 'Total'];
    });
    const r = (await readProformaSheet(buf, 'invoice'))!;
    assert.equal(r.number, '64');
    assert.equal(r.date?.toISOString().slice(0, 10), '2026-10-21');
    assert.deepEqual(r.lines.map((l) => [l.quantity, l.unitPrice]), [[1092, 3], [624, 2.7]]);
  });
});
