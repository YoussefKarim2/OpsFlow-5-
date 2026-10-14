import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { refuseUnbelievable, orderPieces, applyReviewedMatrix } from './import.js';
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
