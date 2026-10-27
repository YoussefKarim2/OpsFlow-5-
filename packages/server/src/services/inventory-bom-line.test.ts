import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bomLineMismatch } from './inventory-service.js';

/**
 * A BOM line id arrives from the client beside an order and a material, and
 * moves that line's issued figure. It has to be a line of that order, linked to
 * that material.
 */
describe('a BOM line named on an issue, return, wastage or reservation', () => {
  const line = { orderId: 'o1', materialId: 'm1', item: 'Rosetta' };

  test('the order’s own line, linked to the material, is accepted', () => {
    assert.equal(bomLineMismatch(line, 'o1', 'm1'), null);
  });

  test('another order’s line is refused', () => {
    assert.match(bomLineMismatch(line, 'o2', 'm1')!, /belongs to a different order/);
  });

  test('a line linked to another material, or to none, is refused', () => {
    assert.match(bomLineMismatch(line, 'o1', 'm2')!, /not linked to this material/);
    assert.match(bomLineMismatch({ ...line, materialId: null }, 'o1', 'm1')!, /not linked to this material/);
  });

  test('a line that is gone is refused', () => {
    assert.match(bomLineMismatch(null, 'o1', 'm1')!, /no longer exists/);
  });
});
