/**
 * The shipped-versus-produced limit is on the order's running total.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  shipmentTotalAfter, assertShippableQuantity, assertPackingWithinReason,
  assertProducedCoversShipped, producedAfterChange,
} from './rules.js';

describe('packed quantity has the production ceiling', () => {
  test('up to 1.5× the larger of order and cut is accepted', () => {
    assert.doesNotThrow(() => assertPackingWithinReason(1500, 1000, 900));
    assert.doesNotThrow(() => assertPackingWithinReason(1650, 1000, 1100));
  });

  test('a carton with an extra digit is refused, with the ceiling in the message', () => {
    assert.throws(() => assertPackingWithinReason(1501, 1000, 900), /1,500/);
  });

  test('an order with no quantity yet is not judged', () => {
    assert.doesNotThrow(() => assertPackingWithinReason(5000, 0, 0));
  });
});

describe('produced may not be corrected below shipped', () => {
  const base = { hasOverridePermission: false, overrideReason: null };

  test('produced is sewing or in-line, whichever is further along', () => {
    assert.equal(producedAfterChange({ inLineQty: 0, sewingQty: 1000, removedSewing: 400, addedSewing: 0 }), 600);
    // In-line is ahead, so taking a sewing entry out does not lower produced.
    assert.equal(producedAfterChange({ inLineQty: 900, sewingQty: 1000, removedSewing: 400, addedSewing: 0 }), 900);
  });

  test('removing an entry below what has shipped needs the override', () => {
    assert.throws(
      () => assertProducedCoversShipped({ ...base, producedBefore: 1000, producedAfter: 600, shippedQty: 800 }),
      /already on shipments/,
    );
  });

  test('with the permission a reason is still required', () => {
    assert.throws(
      () => assertProducedCoversShipped({ producedBefore: 1000, producedAfter: 600, shippedQty: 800, hasOverridePermission: true }),
      /reason/,
    );
    assert.doesNotThrow(() => assertProducedCoversShipped({
      producedBefore: 1000, producedAfter: 600, shippedQty: 800, hasOverridePermission: true, overrideReason: 'miscount',
    }));
  });

  test('a change that stays at or above shipped, or does not lower produced, passes', () => {
    assert.doesNotThrow(() => assertProducedCoversShipped({ ...base, producedBefore: 1000, producedAfter: 800, shippedQty: 800 }));
    // Already shipped past produced under an override: an unrelated edit is not blocked.
    assert.doesNotThrow(() => assertProducedCoversShipped({ ...base, producedBefore: 600, producedAfter: 600, shippedQty: 800 }));
  });
});

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
