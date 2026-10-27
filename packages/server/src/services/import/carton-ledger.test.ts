/**
 * The arithmetic that keeps the PACKED ledger honest when a carton is edited.
 *
 * Adding a carton is easy: increment by what it holds. Editing one is where the
 * bugs live, and there are two obvious wrong answers. Incrementing by the new
 * total counts the pieces already there a second time. Overwriting the ledger
 * row erases quantities packed into *other* cartons of the same size. The right
 * answer is the difference each size makes, which is what this computes and
 * what `PUT /packing/cartons/:id/lines` applies inside one transaction.
 *
 * Pure, and tested here rather than through the route, because the arithmetic
 * is the part that can be wrong and a database is not needed to check it.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ledgerDeltas, cartonHolding, repeatedCartonNumber } from './carton-ledger.js';

describe('adjusting the PACKED ledger for an edited carton', () => {
  test('adding a size increments only that size', () => {
    assert.deepEqual(
      ledgerDeltas(new Map([['S', 10]]), new Map([['S', 10], ['M', 20]])),
      new Map([['M', 20]]),
    );
  });

  test('an unchanged size moves nothing', () => {
    // The double-count guard. A size that still holds ten must not be
    // incremented by ten again.
    assert.deepEqual(ledgerDeltas(new Map([['S', 10]]), new Map([['S', 10]])), new Map());
  });

  test('reducing a size decrements by the difference', () => {
    assert.deepEqual(ledgerDeltas(new Map([['S', 10]]), new Map([['S', 4]])), new Map([['S', -6]]));
  });

  test('removing a size decrements by everything it held', () => {
    assert.deepEqual(
      ledgerDeltas(new Map([['S', 10], ['M', 20]]), new Map([['S', 10]])),
      new Map([['M', -20]]),
    );
  });

  test('emptying a carton returns everything it held', () => {
    assert.deepEqual(
      ledgerDeltas(new Map([['S', 10], ['M', 20]]), new Map()),
      new Map([['S', -10], ['M', -20]]),
    );
  });

  test('a brand-new carton is all increments', () => {
    assert.deepEqual(
      ledgerDeltas(new Map(), new Map([['S', 5], ['M', 5]])),
      new Map([['S', 5], ['M', 5]]),
    );
  });

  test('deltas sum to the change in the carton total', () => {
    // The invariant: whatever moves in the ledger equals what the carton gained
    // or lost, so the two can never drift apart.
    const before = new Map([['S', 10], ['M', 20], ['L', 15]]);
    const after = new Map([['S', 12], ['L', 15], ['XL', 8]]);
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    assert.equal(sum(ledgerDeltas(before, after)), sum(after) - sum(before));
  });
});

describe('removing a carton gives back what it counted', () => {
  test('a single-size carton returns its own quantity', () => {
    const held = cartonHolding({ qty: 24, orderSizeId: 'S', lines: [] });
    assert.deepEqual(ledgerDeltas(held, new Map()), new Map([['S', -24]]));
  });

  test('a mixed carton returns each size row, and free-text sizes return nothing', () => {
    const held = cartonHolding({
      qty: 30, orderSizeId: null,
      lines: [{ orderSizeId: 'S', qty: 10 }, { orderSizeId: 'M', qty: 12 }, { orderSizeId: null, qty: 8 }],
    });
    assert.deepEqual(ledgerDeltas(held, new Map()), new Map([['S', -10], ['M', -12]]));
  });

  test('a carton with rows is counted by its rows, not again by its own size', () => {
    const held = cartonHolding({ qty: 20, orderSizeId: 'S', lines: [{ orderSizeId: 'S', qty: 20 }] });
    assert.deepEqual(held, new Map([['S', 20]]));
  });
});

describe('carton numbers are not repeated on one list', () => {
  test('a number already on the list is caught, whatever its case or spacing', () => {
    assert.equal(repeatedCartonNumber(['CTN-001', 'CTN-002'], [' ctn-002 ']), 'ctn-002');
  });

  test('a batch that repeats itself is caught', () => {
    assert.equal(repeatedCartonNumber([], ['CTN-001', 'CTN-002', 'CTN-001']), 'CTN-001');
  });

  test('new numbers pass', () => {
    assert.equal(repeatedCartonNumber(['CTN-001'], ['CTN-002', 'CTN-003']), null);
  });
});
