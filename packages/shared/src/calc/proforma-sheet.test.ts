import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSheet, defaultSheetTitle, guessHts, guessPerCarton, sheetEta, sheetRowKey, titleCase } from './proforma-sheet.js';
import { computeInvoiceTotals } from './invoice.js';

const item = (description: string, quantity: number, unitPrice: number | null) =>
  ({ kind: 'ITEM' as const, description, quantity, unitPrice, amount: null });
const O = 'AGE.Spring buy 2027';

describe('the factory proforma sheet', () => {
  const lines = [
    item(`${O} — TRANMERE SHIRT — HUNTER/WHT`, 264, 3), item(`${O} — TRANMERE SHIRT — LIME/BLACK`, 288, 3),
    item(`${O} — HILO BACKPACK BLACK`, 1500, 15),
    item(`${O} — ELLAND PERFORMANCE HOODY BLACK`, 132, 9),
    item(`${O} — LANDOW GK SHORT — ORANGE/BLACK`, 36, 7.5),
    { kind: 'EXTRA' as const, description: 'Freight', quantity: null, unitPrice: null, amount: 100 },
  ];
  const orders = [{ poNumber: 'AGE-1', orderName: O }];

  test('one row per style with the Excel equations', () => {
    const { rows, totals } = buildSheet(lines, orders, null);
    assert.deepEqual(rows.map((r) => [r.description, r.qty, r.unitPrice, r.total, r.perCarton, r.cartons, r.hts, r.unit, r.po]), [
      ['Tranmere Shirt', 552, 3, 1656, 120, 5, '6109900000', 'pce', 'AGE-1'],
      ['Hilo Backpack Black', 1500, 15, 22500, 15, 100, '42029291', 'pce', 'AGE-1'],
      ['Elland Performance Hoody Black', 132, 9, 1188, 30, 5, '6109900000', 'pce', 'AGE-1'],
      ['Landow Gk Short', 36, 7.5, 270, 60, 1, '6203430000', 'pce', 'AGE-1'],
    ]);
    assert.equal(totals.qty, 2220);
    assert.equal(totals.cartons, 111);
    assert.equal(totals.total, computeInvoiceTotals(lines).subtotal, 'the sheet total is the goods subtotal');
    assert.equal(totals.containerShare, 111 / 410);
    assert.deepEqual(rows[0]!.lineIndexes, [0, 1]);
  });

  test('typed fields win: cartons, per carton, part no., HTS, weights, PO', () => {
    const key = sheetRowKey('TRANMERE SHIRT', 'AGE-1', false);
    const { rows, totals } = buildSheet(lines, orders, {
      cartonsPerContainer: 200,
      rows: { [key]: { partNo: 'XRA-1003', hts: '6110', cartons: 9, gw: 120.5, nw: 100, po: '84873', description: 'Tranmmer Shirt' } },
    });
    const r = rows[0]!;
    assert.deepEqual([r.partNo, r.hts, r.cartons, r.cartonsTyped, r.gw, r.nw, r.po, r.description], ['XRA-1003', '6110', 9, true, 120.5, 100, '84873', 'Tranmmer Shirt']);
    assert.equal(r.containerShare, 9 / 200);
    assert.equal(totals.gw, 120.5);
    const per = buildSheet(lines, orders, { rows: { [key]: { perCarton: 100 } } }).rows[0]!;
    assert.equal(per.cartons, 6, '552 ÷ 100 rounded up');
  });

  test('an unpriced style leaves its total and the sheet total blank', () => {
    const { rows, totals } = buildSheet([item(`${O} — TRANMERE SHIRT — RED`, 10, null), item(`${O} — HILO BACKPACK BLACK`, 5, 15)], orders, null);
    assert.equal(rows[0]!.total, null);
    assert.equal(totals.total, null);
    assert.equal(totals.qty, 15);
  });

  test('a single-style order is one row, with the order\'s style number as its part no.', () => {
    const { rows } = buildSheet([item('Polo — Navy', 10, 2), item('Polo — Red', 5, 2)], [{ poNumber: '1', orderName: 'Polo', styleNumber: 'XRA-9' }], null);
    assert.deepEqual(rows.map((r) => [r.description, r.qty, r.partNo]), [['Polo', 15, 'XRA-9']]);
  });

  test('helpers', () => {
    assert.equal(sheetEta('2026-12-17', 55), '2027-02-10');
    assert.equal(sheetEta(null, 55), null);
    assert.equal(guessHts('ST. JAMES TRACK PANT BLACK'), '6203430000');
    assert.equal(guessPerCarton('SHUTOUT GK JERSEY'), 60);
    assert.equal(titleCase('ST. JAMES TRACK JKT'), 'St. James Track Jkt');
    assert.equal(defaultSheetTitle('Xara', 'PI-2026-0064', '2026-10-21T00:00:00.000Z'), 'Xara Proforma invoice No.PI-2026-0064 on 21 Oct. 26');
  });
});
