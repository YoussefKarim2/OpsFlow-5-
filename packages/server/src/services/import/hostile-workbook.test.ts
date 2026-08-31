/**
 * The importer against files nobody would design.
 *
 * Every workbook here is one a customer could plausibly send and the importer
 * used to have trouble with: headers on row five, merged title blocks, a date
 * column where three rows out of six are unreadable, sheets in an order that
 * puts the real data third, and column names nobody in this factory uses.
 *
 * The single assertion that matters in all of them: **it does not throw.** An
 * import that reads four hundred rows and then dies on row four hundred and one
 * is worse than one that refuses at the start, because the coordinator has no
 * idea how much of it was understood.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { extractTabular } from './tabular-extractor.js';
import { extractWorkbook } from './extractor.js';

type Row = Array<string | number | Date | null | undefined>;

/** Build an .xlsx in memory from sheets of raw rows. */
async function workbook(sheets: Record<string, Row[]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((row, r) => {
      row.forEach((value, c) => {
        if (value !== undefined) ws.getCell(r + 1, c + 1).value = value as ExcelJS.CellValue;
      });
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const blank: Row = [];

describe('a date column full of rubbish does not stop the import', () => {
  test('the readable rows are read and the unreadable ones are left null', async () => {
    // Six orders, three of which have a date nothing could parse. This is the
    // exact shape that produced "RangeError: Invalid time value".
    const buf = await workbook({
      Orders: [
        ['PO Number', 'Style', 'Colour', 'Size', 'Qty', 'Delivery Date'],
        ['PO-1', 'S1', 'Red', 'M', 100, '2026-09-13'],
        ['PO-1', 'S1', 'Red', 'L', 120, '#VALUE!'],
        ['PO-1', 'S1', 'Blue', 'M', 90, 'TBC'],
        ['PO-1', 'S1', 'Blue', 'L', 80, '13/09/2026'],
        ['PO-1', 'S1', 'Green', 'M', 70, 'sometime after Eid'],
        ['PO-1', 'S1', 'Green', 'L', 60, 46278],
      ],
    });

    const result = await extractTabular(buf, {});
    assert.equal(result.matrices.length, 1);
    assert.equal(
      result.matrices[0]!.rows.reduce((a, r) => a + r.total, 0),
      520,
      'every quantity is read regardless of the dates beside it',
    );

    // Whatever it decided about the date, it is a real Date or nothing.
    const d = result.fields.requiredDeliveryDate;
    if (d != null) {
      assert.ok(d instanceof Date && !Number.isNaN(d.getTime()), 'an Invalid Date escaped');
      assert.doesNotThrow(() => (d as Date).toISOString());
    }
  });

  test('an Invalid Date object written into a cell is survived', async () => {
    const buf = await workbook({
      Orders: [
        ['PO', 'Colour', 'Size', 'Quantity', 'Ship Date'],
        ['PO-2', 'Red', 'M', 50, new Date('absolutely not a date')],
      ],
    });
    await assert.doesNotReject(() => extractTabular(buf, {}));
  });

  test('every field the preview would render survives being stringified', async () => {
    // This is what the API route does to build the preview response, and it is
    // where the crash surfaced.
    const buf = await workbook({
      Orders: [
        ['PO No', 'Color', 'Size', 'Pieces', 'Required Delivery'],
        ['PO-3', 'Sky', 'S', 10, '31/02/2026'],
        ['PO-3', 'Sky', 'M', 20, ''],
      ],
    });
    const result = await extractTabular(buf, {});
    assert.doesNotThrow(() => {
      for (const v of Object.values(result.fields)) {
        if (v instanceof Date) v.toISOString();
      }
      JSON.stringify(result);
    });
  });
});

describe('the header is not on row one', () => {
  test('a title block, blank rows and notes above the table', async () => {
    const buf = await workbook({
      'Order Sheet': [
        ['ACME GARMENTS LTD'],
        ['Purchase Order Confirmation'],
        blank,
        ['Prepared by: Sarah', undefined, undefined, 'Date: 12/08/2026'],
        blank,
        ['Style No', 'Shade', 'Size', 'Pieces'],
        ['ART-99', 'Navy', 'S', 40],
        ['ART-99', 'Navy', 'M', 60],
        ['ART-99', 'Ecru', 'S', 30],
        ['ART-99', 'Ecru', 'M', 45],
        blank,
        ['Note: colours must match the approved lab dip.'],
      ],
    });

    const result = await extractTabular(buf, {});
    assert.equal(result.matrices.length, 1, 'the table below the title block was found');
    assert.equal(result.matrices[0]!.rows.length, 2, 'two colours');
    assert.equal(result.matrices[0]!.rows.reduce((a, r) => a + r.total, 0), 175);
  });
});

describe('a customer’s own vocabulary', () => {
  test('“Article No / Shade / Pieces” reads the same as “Style / Colour / Qty”', async () => {
    const theirs = await workbook({
      Sheet1: [
        ['Purchase Order', 'Article No', 'Shade', 'Size', 'Pieces'],
        ['PO-77', 'A1', 'Red', 'M', 100],
        ['PO-77', 'A1', 'Red', 'L', 150],
      ],
    });
    const ours = await workbook({
      Sheet1: [
        ['PO Number', 'Style', 'Colour', 'Size', 'Qty'],
        ['PO-77', 'A1', 'Red', 'M', 100],
        ['PO-77', 'A1', 'Red', 'L', 150],
      ],
    });

    const a = await extractTabular(theirs, {});
    const b = await extractTabular(ours, {});
    assert.deepEqual(a.matrices[0]!.rows, b.matrices[0]!.rows, 'same order, different words');
    assert.equal(a.fields.poNumber, 'PO-77');
  });
});

describe('a size grid rather than a size column', () => {
  test('colours down, sizes across, exactly as the brief describes', async () => {
    // The example from the requirement: countries down, sizes across.
    const buf = await workbook({
      Quantities: [
        ['PO Number', 'PO-88'],
        blank,
        ['Colour', 'Medium', 'Large', 'XL'],
        ['USA', 15, 18, 10],
        ['Germany', 14, 18, 12],
      ],
    });

    const result = await extractTabular(buf, {});
    const m = result.matrices[0];
    assert.ok(m, 'the grid was recognised as a matrix');
    assert.equal(m.rows.length, 2);
    assert.equal(m.rows.reduce((a, r) => a + r.total, 0), 87);
    assert.deepEqual(m.sizes, ['Medium', 'Large', 'XL']);
  });
});

describe('several sheets, and the data is not on the first', () => {
  test('the sheet with the real table wins over the cover sheet', async () => {
    const buf = await workbook({
      Cover: [['Supplier copy'], ['Please do not edit']],
      Instructions: [['1. Confirm within 48 hours'], ['2. Send the proforma']],
      'Order Lines': [
        ['PO', 'Style', 'Colour', 'Size', 'Qty'],
        ['PO-55', 'ST-1', 'Black', 'M', 200],
        ['PO-55', 'ST-1', 'Black', 'L', 300],
      ],
      Contacts: [['Name', 'Email'], ['Sarah', 'sarah@example.com']],
    });

    const result = await extractTabular(buf, {});
    assert.equal(result.matrices[0]?.rows.reduce((a, r) => a + r.total, 0), 500);
    assert.ok(
      result.sheets.length >= 4,
      'every sheet is inspected and reported, not just the one that won',
    );
  });
});

describe('files that cannot be understood fail honestly', () => {
  test('a workbook with no table says so instead of importing nothing', async () => {
    const buf = await workbook({
      Notes: [['Just some notes'], ['Nothing tabular here at all']],
    });

    const result = await extractTabular(buf, {});
    const errors = result.issues.filter((i) => i.level === 'ERROR');
    assert.ok(errors.length > 0, 'an unreadable file must be refused, not silently accepted');
    assert.ok(
      errors.some((e) => e.message.length > 20),
      'and the refusal must explain itself',
    );
  });

  test('an empty workbook does not throw', async () => {
    const buf = await workbook({ Sheet1: [] });
    await assert.doesNotReject(() => extractTabular(buf, {}));
  });

  test('a file that is not a workbook at all is rejected, not crashed on', async () => {
    await assert.rejects(() => extractWorkbook(Buffer.from('this is not a spreadsheet')));
  });
});

describe('merged cells', () => {
  test('a merged title spanning the table does not become a column header', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Order');
    ws.mergeCells('A1:E1');
    ws.getCell('A1').value = 'CUSTOMER ORDER — SUMMER 2026';
    ws.getRow(3).values = ['PO Number', 'Style', 'Colour', 'Size', 'Qty'];
    ws.getRow(4).values = ['PO-11', 'S9', 'Red', 'M', 25];
    ws.getRow(5).values = ['PO-11', 'S9', 'Red', 'L', 35];
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const result = await extractTabular(buf, {});
    assert.equal(result.matrices[0]?.rows.reduce((a, r) => a + r.total, 0), 60);
    assert.equal(result.fields.poNumber, 'PO-11');
  });
});
