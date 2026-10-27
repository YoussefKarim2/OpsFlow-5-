import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  refuseUnbelievable, orderPieces, applyReviewedMatrix, buildPreview, warnFractionalQuantities, warnIfPoExists,
  columnOverridesFrom,
} from './import.js';
import type { ExtractionResult } from '../services/import/extractor.js';

const extraction = (rows: Array<{ color: string; cells: Record<string, number> }>, sizes = ['M']): ExtractionResult => ({
  profileKey: null, confidence: 0, sheets: [], mappings: [], issues: [], fields: {}, lineItems: [], bom: [], lays: [], externalColors: [], costing: {},
  matrices: [{ ledger: 'ORDER', sizes, rows: rows.map((r) => ({ ...r, total: Object.values(r.cells).reduce((a, b) => a + b, 0) })), sheetTotal: null, computedTotal: 0 }],
} as unknown as ExtractionResult);

describe('what the file path refuses before an order is made', () => {
  test('a million pieces of one size is a misread', () => {
    assert.throws(() => refuseUnbelievable(extraction([{ color: 'Red', cells: { M: 20_000_000 } }])), /20,000,000 pieces/);
  });
  test('a colour name two hundred characters long is not a colour', () => {
    assert.throws(() => refuseUnbelievable(extraction([{ color: 'x'.repeat(200), cells: { M: 1 } }])), /200 characters/);
  });
  test('a size eighty characters long is not a size', () => {
    assert.throws(() => refuseUnbelievable(extraction([{ color: 'Navy', cells: { ['s'.repeat(80)]: 1 } }], ['s'.repeat(80)])), /80 characters/);
  });
  test('an ordinary order passes', () => {
    const e = extraction([{ color: 'Navy', cells: { M: 1200, L: 800 } }], ['M', 'L']);
    assert.doesNotThrow(() => refuseUnbelievable(e));
    assert.equal(orderPieces(e), 2000);
  });
  test('the reviewed grid replaces the file grid', () => {
    const e = extraction([{ color: 'Navy', cells: { M: 1 } }]);
    applyReviewedMatrix(e, { sizes: ['S'], rows: [{ color: 'Red', cells: { S: 5, XL: 9 } }] });
    assert.equal(orderPieces(e), 5, 'a cell under a size that is not a column is ignored');
  });
});

describe('what the review screen is told before confirming', () => {
  test('the preview total is the grid it shows, which is what the commit writes (t10b)', () => {
    // The reader said 126 while its grid held 81: a size heading written twice
    // overwrote the first column's pieces. Whatever the reader's figure, the
    // total shown is the sum of the rows shown.
    const e = extraction([{ color: 'Navy', cells: { S: 20 } }, { color: 'navy', cells: { S: 5 } }], ['S']);
    e.matrices[0]!.computedTotal = 999;
    const p = buildPreview(e);
    assert.equal(p.matrixTotal, 25);
    assert.equal(p.matrixRows.reduce((a, r) => a + Object.values(r.cells).reduce((b, q) => b + q, 0), 0), 25);
    assert.equal(orderPieces(e), p.matrixTotal);
  });

  test('a quantity that is not whole is warned about, with what it becomes', () => {
    const e = extraction([{ color: 'Navy', cells: { S: 10.6, M: 0.4, L: 3 } }], ['S', 'M', 'L']);
    warnFractionalQuantities(e);
    assert.equal(e.issues.length, 1);
    assert.match(e.issues[0]!.message, /2 quantities are not a whole number.*Navy \/ S: 10\.6 \(imported as 11\); Navy \/ M: 0\.4 \(imported as 0\)/s);
    const whole = extraction([{ color: 'Navy', cells: { S: 10 } }], ['S']);
    warnFractionalQuantities(whole);
    assert.equal(whole.issues.length, 0);
  });

  test('a PO already in the system is named at the preview, not first at the commit', async () => {
    const e = extraction([{ color: 'Navy', cells: { M: 1 } }]);
    e.fields.poNumber = ' po-5510 ';
    let asked = '';
    await warnIfPoExists(e, async (po) => { asked = po; return { id: 'o1', poNumber: 'PO-5510', clientName: 'Hummel A/S' }; });
    assert.equal(asked, 'PO-5510', 'looked up as the commit will write it');
    assert.match(e.issues[0]!.message, /PO PO-5510 is already in the system \(Hummel A\/S\)/);
    assert.equal(e.issues[0]!.level, 'WARNING');

    const fresh = extraction([{ color: 'Navy', cells: { M: 1 } }]);
    fresh.fields.poNumber = 'PO-1';
    await warnIfPoExists(fresh, async () => null);
    assert.equal(fresh.issues.length, 0);
  });

  test('a column mapping that names no concept is a 400 (t9)', () => {
    assert.throws(() => columnOverridesFrom({ 0: 'NOT_A_CONCEPT' }), (e: Error & { status?: number }) => e.status === 400);
    assert.deepEqual(columnOverridesFrom({ 2: 'QUANTITY' }), { 2: 'QUANTITY' });
  });
});
