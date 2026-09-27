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

import { extractWorkbook, fabricBomFromLays } from './extractor.js';
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

/**
 * The lay plan, found under its real header.
 *
 * On the AGE workbook the "Laying fabric instructions" sheet has a "Fabric 1 /
 * Fabric 2 / Fabric 3 / Fabric Description" block above the table, and the
 * header anchor "fabric" was matched as a prefix — it stopped at "Fabric 1",
 * read the rows beneath that caption as lays, and every AGE import came out
 * with no lay plan at all. Laid out here exactly as the real sheet has it.
 */
describe('the lay plan', () => {
  async function withLayPlan(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    for (const name of AGE_ORDER_V1.signature.names) wb.addWorksheet(name);
    const lay = wb.getWorksheet('Laying fabric instructions_Patr')!;
    lay.getCell('H7').value = 'Fabric 1';           lay.getCell('K7').value = 'Rosetta';
    lay.getCell('H8').value = 'Fabric 2';
    lay.getCell('H9').value = 'Fabric 3';
    lay.getCell('H10').value = 'Fabric Description';
    const header = ['fabric', 'Color', 'PANAL', 'SIZE', 'S', 'M', 'Total', 'Layers', 'Total \nLength', 'NEST', 'Marker \nLength'];
    header.forEach((h, i) => { lay.getCell(13, 3 + i).value = h; });
    const data = ['Rosetta', 'USA', 'ALL', '(S1)(M1)', 1, 1, 2, 12, 30.5, 2, 2.4];
    data.forEach((v, i) => { lay.getCell(15, 3 + i).value = v; });
    lay.getCell(20, 3).value = 'TOTAL';
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  test('a caption that begins with the same word is not the header', async () => {
    const r = await extractWorkbook(await withLayPlan());
    assert.deepEqual(r.lays, [{
      fabric: 'Rosetta', color: 'USA', panel: 'ALL', sizeRatio: '(S1)(M1)',
      layers: 12, markerLengthM: 2.4, totalLengthM: 30.5, nestPcs: 2,
    }]);
  });
});

/**
 * The BOM's fabric lines.
 *
 * On the real AGE workbook the BOM sheet's header is found, but the rows under
 * it are a dynamic-array spill — `=ANCHORARRAY('Laying fabric
 * instructions_Patr'!C46)` — computed from the lay plan, and the file caches
 * #VALUE! with no spilled values. The section read as empty on every import.
 * The lines are rebuilt from the lay plan the way that formula builds them.
 */
describe('fabric lines on the bill of materials', () => {
  const lay = (fabric: string, panel: string, color: string, totalLengthM: number | null) => ({
    fabric, color, panel, sizeRatio: '(S1)', layers: 1, markerLengthM: 1, totalLengthM, nestPcs: 1,
  });

  test('one line per fabric, panel and colour, with the metres added', () => {
    const lines = fabricBomFromLays([
      lay('Rosetta', 'ALL', 'USA', 30.5),
      lay('Rosetta', 'ALL', 'USA', 10),
      lay('Rosetta', 'ALL', 'Germany', 20),
      lay('Mesh', 'Back', 'USA', 0),        // no metres: the formula filters it out
    ]);
    assert.deepEqual(lines.map((l) => [l.category, l.position, l.item, l.color, l.requiredQty, l.unit]), [
      ['Fabric', 'ALL', 'Rosetta', 'USA', 40.5, 'meter'],
      ['Fabric', 'ALL', 'Rosetta', 'Germany', 20, 'meter'],
    ]);
  });

  test('a workbook whose BOM rows are an uncached spill still yields its fabric lines', async () => {
    const wb = new ExcelJS.Workbook();
    for (const name of AGE_ORDER_V1.signature.names) wb.addWorksheet(name);
    const layS = wb.getWorksheet('Laying fabric instructions_Patr')!;
    ['fabric', 'Color', 'PANAL', 'SIZE', 'Layers', 'Total \nLength'].forEach((h, i) => { layS.getCell(13, 3 + i).value = h; });
    ['Rosetta', 'USA', 'ALL', '(S1)(M1)', 12, 30.5].forEach((v, i) => { layS.getCell(15, 3 + i).value = v; });
    layS.getCell(20, 3).value = 'TOTAL';

    const bomS = wb.getWorksheet('Bill Of Matrial_Coord_Warehouse')!;
    ['Item Sort', 'Position', 'Coms./Piece', 'Item', 'Description', 'Color', 'Order Qty', 'Unit']
      .forEach((h, i) => { bomS.getCell(16, 3 + i).value = h; });
    // The spill's anchor, as the real file stores it: a formula whose cached
    // result is an error, and nothing in the cells it would spill into.
    bomS.getCell('C17').value = {
      formula: "_xlfn.ANCHORARRAY('Laying fabric instructions_Patr'!C46)",
      result: { error: '#VALUE!' },
    } as ExcelJS.CellValue;

    const r = await extractWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.equal(r.bom.length, 1);
    assert.deepEqual(
      [r.bom[0]!.category, r.bom[0]!.position, r.bom[0]!.item, r.bom[0]!.color, r.bom[0]!.requiredQty, r.bom[0]!.unit],
      ['Fabric', 'ALL', 'Rosetta', 'USA', 30.5, 'meter'],
    );
  });
});
