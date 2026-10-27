/**
 * The shipped-versus-produced limit is on the order's running total.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { shipmentTotalAfter, assertShippableQuantity, assertUnchangedSince } from './rules.js';
import { ConflictError } from '../errors.js';

describe('an order edit is checked against the version it was made from', () => {
  const now = new Date('2026-10-27T09:15:30.123Z');

  test('the same version saves', () => {
    assert.doesNotThrow(() => assertUnchangedSince(now.toISOString(), now));
  });

  test('a moved order refuses the save, with a sentence and a 409', () => {
    assert.throws(
      () => assertUnchangedSince('2026-10-27T09:00:00.000Z', now),
      (e: unknown) => e instanceof ConflictError && e.status === 409 && /changed this order/.test(e.message),
    );
  });

  test('a caller that sends no version is not checked', () => {
    assert.doesNotThrow(() => assertUnchangedSince(undefined, now));
    assert.doesNotThrow(() => assertUnchangedSince(null, now));
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
