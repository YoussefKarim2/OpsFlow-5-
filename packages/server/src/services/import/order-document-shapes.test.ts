import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { extractTabular } from './tabular-extractor.js';

/**
 * The shapes a customer's purchase order actually arrives in.
 *
 * Every case here is a layout somebody could reasonably send, and each one is
 * checked for the *values* it should yield rather than merely for not throwing
 * — a reader that returns nothing without complaining is the failure this
 * section keeps producing.
 */
async function book(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const total = (r: Awaited<ReturnType<typeof extractTabular>>): number =>
  (r.matrices.find((m) => m.ledger === 'ORDER')?.computedTotal) ?? 0;

describe('a purchase order, in the shapes they arrive in', () => {
  test('a colour by size grid', async () => {
    const r = await extractTabular(await book({ Order: [
      ['PO Number:', 'D1', '', 'Customer:', 'Meyba'], [],
      ['Colour', 'S', 'M', 'L'], ['Navy', 10, 20, 30], ['White', 5, 10, 15],
    ] }));
    assert.equal(r.fields.poNumber, 'D1');
    assert.equal(r.fields.clientName, 'Meyba');
    assert.equal(total(r), 90);
  });

  test('a long table of colour, size and quantity', async () => {
    const r = await extractTabular(await book({ Order: [
      ['PO Number:', 'D2'], [],
      ['Colour', 'Size', 'Quantity'], ['Navy', 'S', 10], ['Navy', 'M', 20], ['White', 'S', 5],
    ] }));
    assert.equal(total(r), 35);
  });

  test('numeric size headings', async () => {
    // Waist sizes, shoe sizes and children's ages are all numbers. The rule
    // that "a mostly-numeric row is data" threw the entire sheet away.
    const r = await extractTabular(await book({ Order: [
      ['PO Number:', 'D4'], [], ['Colour', 28, 30, 32], ['Denim', 11, 12, 13],
    ] }));
    assert.equal(r.fields.poNumber, 'D4');
    assert.equal(total(r), 36);
    assert.equal(r.matrices.find((m) => m.ledger === 'ORDER')?.sizes.length, 3);
  });

  test('quantities written with thousands separators', async () => {
    const r = await extractTabular(await book({ Order: [
      ['PO Number:', 'D5'], [], ['Colour', 'S', 'M'], ['Navy', '1,200', '800'],
    ] }));
    assert.equal(total(r), 2000);
  });

  test('a totals row is not counted twice', async () => {
    const r = await extractTabular(await book({ Order: [
      ['PO Number:', 'D6'], [], ['Colour', 'S', 'M'],
      ['Navy', 10, 20], ['White', 5, 10], ['TOTAL', 15, 30],
    ] }));
    assert.equal(total(r), 45);
  });

  test('blank rows in the middle do not end the table', async () => {
    const r = await extractTabular(await book({ Order: [
      ['PO Number:', 'D7'], [], ['Colour', 'S', 'M'], ['Navy', 10, 20], [], ['White', 5, 10],
    ] }));
    assert.equal(total(r), 45);
  });

  test('columns the reader does not recognise are ignored, not fatal', async () => {
    const r = await extractTabular(await book({ Order: [
      ['PO Number:', 'D8'], [], ['Ref', 'Colour', 'Notes', 'S', 'M'], ['x', 'Navy', 'hello', 10, 20],
    ] }));
    assert.equal(total(r), 30);
  });

  test('the table is found on a later sheet', async () => {
    const r = await extractTabular(await book({
      Cover: [['Nothing here']],
      Order: [['PO Number:', 'D9'], [], ['Colour', 'S', 'M'], ['Navy', 10, 20]],
    }));
    assert.equal(total(r), 30);
  });

  test('numbers stored as text are still numbers', async () => {
    const r = await extractTabular(await book({ Order: [
      ['PO Number:', 'D10'], [], ['Colour', 'S', 'M'], ['Navy', '10', '20'],
    ] }));
    assert.equal(total(r), 30);
  });

  test('a price written with a currency symbol', async () => {
    const r = await extractTabular(await book({ Order: [
      ['PO Number:', 'D11', '', 'Price per piece:', '$5.75'], [], ['Colour', 'S'], ['Navy', 10],
    ] }));
    assert.equal(r.fields.pricePerPieceUsd, 5.75);
  });

  test('a date written day-first', async () => {
    const r = await extractTabular(await book({ Order: [
      ['PO Number:', 'D12', '', 'Delivery date:', '20/04/2026'], [], ['Colour', 'S'], ['Navy', 10],
    ] }));
    const d = r.fields.requiredDeliveryDate as Date;
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString().slice(0, 10), '2026-04-20');
  });

  test('a CSV grid reads the same as a workbook', async () => {
    const r = await extractTabular(Buffer.from('Colour,S,M\nNavy,10,20\nWhite,5,10'));
    assert.equal(total(r), 45);
  });
});
