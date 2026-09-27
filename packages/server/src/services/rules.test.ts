/**
 * The shipped-versus-produced limit is on the order's running total.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { shipmentTotalAfter, assertShippableQuantity } from './rules.js';

describe('shipments are checked against everything already shipped', () => {
  const existing = [{ id: 'a', qty: 600 }, { id: 'b', qty: 300 }];

  test('a new consignment adds to the ones already recorded', () => {
    assert.equal(shipmentTotalAfter(existing, 200), 1100);
    // The regression: each row was checked alone, so 200 against 1,000
    // produced passed although 1,100 would then have gone.
    assert.throws(() => assertShippableQuantity({
      shippedQty: shipmentTotalAfter(existing, 200), producedQty: 1000, hasOverridePermission: false,
    }));
  });

  test('an edited consignment is counted once, at its new quantity', () => {
    assert.equal(shipmentTotalAfter(existing, 700, 'b'), 1300);
    assert.equal(shipmentTotalAfter(existing, 300, 'b'), 900, 'a status change alone does not grow the total');
    assert.doesNotThrow(() => assertShippableQuantity({
      shippedQty: shipmentTotalAfter(existing, 300, 'b'), producedQty: 1000, hasOverridePermission: false,
    }));
  });
});
