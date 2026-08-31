/**
 * The profile extractor, against PO 13506.
 *
 * These tests were written *after* running the real
 * `PO No. 85 13506 Florida T Shirt Summer order 2026.xlsx` through the
 * importer, and each one exists because that run produced a wrong answer that
 * nothing complained about. The workbook is not committed — it is 2 MB of
 * customer artwork — so the two traps it laid are reconstructed here in memory,
 * exactly as the file has them.
 *
 * The values asserted are read out of that workbook, not invented: 1,972 pieces
 * across four colours, PO 13506, ProTime, $7.25.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { extractWorkbook } from './extractor.js';
import { AGE_ORDER_V1 } from './profiles.js';

/** PO 13506's own quantity grid, colour by colour. */
const SIZES = ['2YXS', 'YXS', 'YS', 'YM', 'YL', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const GRID: Array<[string, number[]]> = [
  ['SKY BLUE',  [20, 50, 138, 141, 90, 70, 35, 20, 10, 5, 0]],
  ['ATH. GOLD', [20, 55, 114, 115, 60, 30, 35, 20, 10, 5, 0]],
  ['SCARLET',   [20, 40,  80,  80, 70, 30, 35, 15, 10, 5, 0]],
  ['LIME',      [20, 50, 138, 141, 80, 50, 35, 15, 10, 5, 0]],
];
const ORDER_TOTAL = 1972;

/**
 * A workbook shaped like the real one.
 *
 * Every sheet the profile expects exists so the file is recognised, and the two
 * populated sheets carry the header block and matrix at the cells PO 13506 uses
 * — including the merged "Billing Adress" label at F9:F12 that sits to the
 * right of the empty Fit and Block Pattern cells.
 */
async function buildWorkbook(opts: {
  /** Leave Fit and Block Pattern blank, as PO 13506 does. */
  blankFit?: boolean;
  /** Write the size header as formulas with no cached result, as Stock does. */
  formulaSizeHeader?: boolean;
} = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const name of AGE_ORDER_V1.signature.names) wb.addWorksheet(name);

  const od = wb.getWorksheet('Order Details_Coordinator')!;
  od.getCell('C5').value = 'Client';        od.getCell('D5').value = 'ProTime ';
  od.getCell('C6').value = 'Seasson';       od.getCell('D6').value = 'Summer 26';
  od.getCell('C7').value = 'Po No';         od.getCell('D7').value = '13506';
  od.getCell('C8').value = 'Order name';    od.getCell('D8').value = 'Florida T shirt';
  od.getCell('C9').value = 'Item Type :';   od.getCell('D9').value = 'T-Shirt';
  od.getCell('C10').value = 'Fit';
  od.getCell('C11').value = 'Block Pattern';
  if (!opts.blankFit) {
    od.getCell('D10').value = 'Regular';
    od.getCell('D11').value = 'Block 4';
  }
  od.getCell('C12').value = 'Gender';       od.getCell('D12').value = 'Male';
  od.getCell('C13').value = 'Style No';     od.getCell('D13').value = '3091';
  od.getCell('C16').value = 'Price in US$'; od.getCell('D16').value = 7.25;
  od.getCell('C18').value = 'Cut Percentage'; od.getCell('D18').value = 0.05;
  od.getCell('C20').value = 'Fabric';       od.getCell('D20').value = 'Rosetta';

  // The trap. A merged label four rows tall, immediately right of the blanks.
  od.getCell('F5').value = 'Shipping Adress';
  od.mergeCells('G5:H8');
  od.getCell('G5').value = 'FLORIDA CELTIC\nJOHN ORR';
  od.mergeCells('F9:F12');
  od.getCell('F9').value = 'Billing Adress';
  od.mergeCells('G9:H12');
  od.getCell('G9').value = 'PROTIME SPORTS INC';

  const mo = wb.getWorksheet('Main Order_Factory.Manger')!;
  mo.getCell('C22').value = 'Color';
  SIZES.forEach((s, i) => {
    const cell = mo.getCell(22, 4 + i);
    // A shared-formula header with no cached result — what a workbook saved by
    // something other than Excel looks like.
    cell.value = opts.formulaSizeHeader
      ? ({ formula: `'Data-Base'!A${i + 1}`, result: undefined } as ExcelJS.CellValue)
      : s;
  });
  mo.getCell(22, 4 + SIZES.length).value = 'Total';

  GRID.forEach(([color, qty], r) => {
    mo.getCell(23 + r, 3).value = color;
    qty.forEach((q, i) => { if (q > 0) mo.getCell(23 + r, 4 + i).value = q; });
    mo.getCell(23 + r, 4 + SIZES.length).value = qty.reduce((a, b) => a + b, 0);
  });
  mo.getCell(45, 3).value = 'Totals';
  mo.getCell(45, 4 + SIZES.length).value = ORDER_TOTAL;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('PO 13506 reads as PO 13506', () => {
  test('the workbook is recognised and its facts come back intact', async () => {
    const r = await extractWorkbook(await buildWorkbook());

    assert.equal(r.profileKey, 'age-order-v1');
    assert.equal(r.confidence, 1);
    assert.equal(r.fields.poNumber, '13506');
    assert.equal(r.fields.clientName, 'ProTime');
    assert.equal(r.fields.orderName, 'Florida T shirt');
    assert.equal(r.fields.itemType, 'T-Shirt');
    assert.equal(r.fields.styleNumber, '3091');
    assert.equal(r.fields.pricePerPieceUsd, 7.25);
    assert.equal(r.fields.fabric, 'Rosetta');
  });

  test('the quantity matrix adds to the workbook’s own total', async () => {
    const r = await extractWorkbook(await buildWorkbook());
    const order = r.matrices.find((m) => m.ledger === 'ORDER');

    assert.ok(order, 'the ORDER matrix must be found');
    assert.equal(order.rows.length, 4, 'four colours');
    assert.equal(order.computedTotal, ORDER_TOTAL);
    assert.equal(order.sheetTotal, ORDER_TOTAL, 'our arithmetic agrees with the sheet’s own SUM');
    assert.equal(order.rows.find((x) => x.color === 'SKY BLUE')?.total, 579);
    assert.equal(order.rows.find((x) => x.color === 'LIME')?.total, 544);
  });
});

describe('a blank cell does not borrow the label beside it', () => {
  /**
   * The bug this replaces: "Fit" at C10 with D10 empty, and F9:F12 merged
   * holding "Billing Adress". ExcelJS reports a merged value in every cell of
   * the range, so scanning right from the blank found text and imported the
   * order with a fit of "Billing Adress". No rule was broken — a string went
   * into a string column — so nothing complained.
   */
  test('an empty field stays empty rather than picking up a neighbouring heading', async () => {
    const r = await extractWorkbook(await buildWorkbook({ blankFit: true }));

    assert.equal(r.fields.fit, null, 'PO 13506 leaves Fit blank, and blank is the honest answer');
    assert.equal(r.fields.blockPattern, null);

    // It must be reported as unfound, not quietly absent.
    const fit = r.mappings.find((m) => m.field === 'fit');
    assert.ok(fit, 'the fit mapping must still be listed');
    assert.equal(fit.resolved, false, 'an empty field is an unresolved mapping the user can see');
  });

  test('a field that IS filled is still read, so the guard has not just broken reading', async () => {
    const r = await extractWorkbook(await buildWorkbook({ blankFit: false }));
    assert.equal(r.fields.fit, 'Regular');
    assert.equal(r.fields.blockPattern, 'Block 4');
  });
});

describe('a formula with no cached result is nothing, not “[object Object]”', () => {
  /**
   * PO 13506's Stock sheet takes its entire size header by formula from Main
   * Order. Saved by something other than Excel, those cells carry no cached
   * result, and the extractor's `String(value)` fallback produced four size
   * columns literally named "[object Object]" — headings that look like data.
   */
  test('unreadable size headers are dropped, never stringified', async () => {
    const r = await extractWorkbook(await buildWorkbook({ formulaSizeHeader: true }));
    const order = r.matrices.find((m) => m.ledger === 'ORDER');

    for (const size of order?.sizes ?? []) {
      assert.ok(!size.includes('[object'), `size header "${size}" is a JavaScript object, not a size`);
    }
  });
});
