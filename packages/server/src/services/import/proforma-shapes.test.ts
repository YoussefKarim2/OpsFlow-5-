import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { extractTabular } from './tabular-extractor.js';
import { buildProformaDraft } from './proforma-target.js';

/**
 * A proforma invoice arrives in whatever shape the person who wrote it chose.
 *
 * Most are a list — a description, how many, what each costs. Some state one
 * price at the top and list only quantities. Some are a colour x size grid.
 * The headings differ every time. Until the readers exposed line-shaped rows,
 * only the grid produced anything, and a list imported with its header filled
 * and no items at all.
 */
async function sheet(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('PI');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const draftFrom = async (rows: unknown[][]) =>
  buildProformaDraft(await extractTabular(await sheet(rows)));

describe('a proforma in whatever shape it arrives', () => {
  test('a priced list', async () => {
    const d = await draftFrom([
      ['PROFORMA INVOICE'],
      ['PO Number:', 'PI-101', '', 'Customer:', 'Meyba'],
      [],
      ['Description', 'Quantity', 'Unit', 'Unit Price'],
      ['T-Shirt Navy S', 100, 'PCS', 5.75],
      ['T-Shirt White L', 80, 'PCS', 6.20],
    ]);
    assert.equal(d.number, 'PI-101');
    assert.equal(d.consignee, 'Meyba');
    assert.equal(d.lines.length, 2);
    assert.equal(d.lines[0]!.description, 'T-Shirt Navy S');
    assert.equal(d.lines[0]!.quantity, 100);
    assert.equal(d.lines[0]!.unitPrice, 5.75);
    // Each row keeps its own price rather than inheriting one.
    assert.equal(d.lines[1]!.unitPrice, 6.20);
  });

  test('a list whose headings are worded differently', async () => {
    const d = await draftFrom([
      ['Number:', 'PI-102', '', 'Consignee:', 'Hummel'],
      [],
      ['Item', 'Pcs', 'UOM', 'Rate'],
      ['Polo Shirt Red', 50, 'PCS', 8.10],
    ]);
    assert.equal(d.lines.length, 1);
    assert.equal(d.lines[0]!.quantity, 50);
    assert.equal(d.lines[0]!.unitPrice, 8.10);
  });

  test('a two-column list with one price stated at the top', async () => {
    // Two columns wide, which used to be too narrow to be seen as a table at
    // all — no header candidate, no lines, nothing.
    const d = await draftFrom([
      ['PO Number:', 'PI-103', '', 'Customer:', 'Meyba'],
      ['Unit price:', 4.5],
      [],
      ['Description', 'Quantity'],
      ['Jersey Navy', 300],
      ['Jersey White', 200],
    ]);
    assert.equal(d.number, 'PI-103', 'the caption block must not be read as the table');
    assert.equal(d.lines.length, 2);
    // The document priced the lot once; every line inherits it.
    assert.equal(d.lines[0]!.unitPrice, 4.5);
    assert.equal(d.lines[1]!.unitPrice, 4.5);
  });

  test('a colour by size grid still works', async () => {
    const d = await draftFrom([
      ['PO Number:', 'PI-104', '', 'Customer:', 'Meyba'],
      [],
      ['Colour', 'S', 'M', 'L'],
      ['Navy', 100, 200, 150],
    ]);
    assert.equal(d.number, 'PI-104');
    assert.equal(d.lines.length, 3);
    assert.ok(d.lines[0]!.description.includes('Navy'));
  });

  test('a totals row is not invoiced again', async () => {
    const d = await draftFrom([
      ['Description', 'Quantity', 'Unit Price'],
      ['Shorts Black', 120, 3.4],
      ['TOTAL', 120, ''],
    ]);
    assert.equal(d.lines.length, 1, 'the total restates the invoice, it is not a line on it');
  });

  test('a document that states its lines is preferred over its grid', async () => {
    // Both shapes present. What the document wrote down wins over what could
    // be rebuilt from a grid.
    const d = await draftFrom([
      ['Description', 'Quantity', 'Unit Price'],
      ['Jersey Navy', 100, 5.75],
    ]);
    assert.equal(d.lines.length, 1);
    assert.equal(d.lines[0]!.description, 'Jersey Navy');
  });
});
