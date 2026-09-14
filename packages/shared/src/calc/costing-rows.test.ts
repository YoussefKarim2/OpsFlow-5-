import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyRowEdit, rowCost, type RowState } from './costing-rows.js';

const blank: RowState = { quantity: null, unitPriceUsd: null, derivedField: null };

/**
 * A costing row is three numbers with one relationship. Which two a person has
 * depends on what they are holding — an invoice, a price list, a warehouse
 * docket — so any one of the three can be typed and the others follow. What
 * must never happen is the system overwriting a figure the person entered.
 */
describe('a costing row works in whichever direction it is given', () => {
  test('consumption then price gives the cost', () => {
    let row = applyRowEdit(blank, 'quantity', 1.25);
    row = applyRowEdit(row, 'unitPrice', 4);
    assert.equal(rowCost(row), 5);
    assert.equal(row.derivedField, 'cost');
  });

  test('changing the consumption re-costs it, and does not touch the price', () => {
    let row = applyRowEdit(applyRowEdit(blank, 'quantity', 2), 'unitPrice', 5);
    assert.equal(rowCost(row), 10);
    row = applyRowEdit(row, 'quantity', 3);
    assert.equal(rowCost(row), 15);
    assert.equal(row.unitPriceUsd, 5, 'the price the person entered is untouched');
  });

  test('a cost against a known consumption gives the unit price', () => {
    let row = applyRowEdit(blank, 'quantity', 4);
    row = applyRowEdit(row, 'cost', 10);
    assert.equal(row.unitPriceUsd, 2.5);
    assert.equal(row.derivedField, 'unitPrice');
    assert.equal(rowCost(row), 10, 'and the row still multiplies out to what was typed');
  });

  test('a cost against a known unit price gives the consumption', () => {
    let row = applyRowEdit(blank, 'unitPrice', 2);
    row = applyRowEdit(row, 'cost', 50);
    assert.equal(row.quantity, 25);
    assert.equal(row.derivedField, 'quantity');
  });

  test('a cost with nothing else is one lot at that price', () => {
    // A freight charge has no consumption. Recording it as 1 × $340 keeps the
    // row multiplying out instead of carrying a cost with no inputs.
    const row = applyRowEdit(blank, 'cost', 340);
    assert.equal(row.quantity, 1);
    assert.equal(row.unitPriceUsd, 340);
    assert.equal(rowCost(row), 340);
  });

  test('the derived figure is the one that moves, never the typed one', () => {
    // Consumption and cost are the person's; the price is the system's.
    let row = applyRowEdit(applyRowEdit(blank, 'quantity', 10), 'cost', 100);
    assert.equal(row.unitPriceUsd, 10);
    row = applyRowEdit(row, 'quantity', 20);
    assert.equal(rowCost(row), 100, 'the cost the person typed is held');
    assert.equal(row.unitPriceUsd, 5, 'the price is re-rated instead');
  });

  test('re-rating works the other way too', () => {
    let row = applyRowEdit(applyRowEdit(blank, 'unitPrice', 4), 'cost', 40);
    assert.equal(row.quantity, 10);
    row = applyRowEdit(row, 'unitPrice', 8);
    assert.equal(rowCost(row), 40, 'the cost is held');
    assert.equal(row.quantity, 5);
  });

  test('clearing a field clears what was worked out from it', () => {
    let row = applyRowEdit(applyRowEdit(blank, 'quantity', 4), 'cost', 10);
    assert.equal(row.unitPriceUsd, 2.5);
    row = applyRowEdit(row, 'quantity', null);
    assert.equal(row.quantity, null);
    assert.equal(row.unitPriceUsd, null, 'a price derived from a gone consumption is gone too');
    assert.equal(rowCost(row), null);
  });

  test('clearing the cost clears whichever half the system supplied', () => {
    const row = applyRowEdit(applyRowEdit(applyRowEdit(blank, 'quantity', 4), 'cost', 10), 'cost', null);
    assert.equal(row.quantity, 4, 'what the person typed stays');
    assert.equal(row.unitPriceUsd, null);
  });

  test('a zero consumption never becomes a divisor', () => {
    const row = applyRowEdit(applyRowEdit(blank, 'quantity', 0), 'cost', 50);
    assert.ok(row.unitPriceUsd == null || Number.isFinite(row.unitPriceUsd));
    assert.equal(rowCost(row) == null || Number.isFinite(rowCost(row)!), true);
  });

  test('no sequence of edits can produce an unrenderable number', () => {
    const values: Array<number | null> = [null, 0, 1, -1, 0.001, 1e9];
    const fields = ['quantity', 'unitPrice', 'cost'] as const;
    let row = blank;
    for (const f of fields) {
      for (const v of values) {
        row = applyRowEdit(row, f, v);
        for (const n of [row.quantity, row.unitPriceUsd, rowCost(row)]) {
          assert.ok(n == null || Number.isFinite(n), `${f}=${v} produced ${n}`);
        }
      }
    }
  });
});
