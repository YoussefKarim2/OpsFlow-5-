import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sizeRowsFromCut, computeBomSummary, type CutSize } from './materials.js';

/**
 * The bill of materials' per-size breakdown comes from the cut order: a size
 * label or a hang tag is needed once per cut piece of each size, and the cut
 * order — not the person typing the BOM — knows how many that is.
 */
describe('size rows from the cut order', () => {
  const sizes: CutSize[] = [
    { name: 'S', cutQty: 105, orderQty: 100 },
    { name: 'M', cutQty: 210, orderQty: 200 },
    { name: 'L', cutQty: 0, orderQty: 0 },
  ];

  test('one row per size with pieces to cut, at one per piece', () => {
    assert.deepEqual(sizeRowsFromCut(sizes), [
      { sizeLabel: 'S', qty: 105 },
      { sizeLabel: 'M', qty: 210 },
    ]);
  });

  test('a consumption per piece multiplies the pieces, to four places', () => {
    assert.deepEqual(sizeRowsFromCut(sizes, 0.0375), [
      { sizeLabel: 'S', qty: 3.9375 },
      { sizeLabel: 'M', qty: 7.875 },
    ]);
    // Not 49.98750000000001.
    assert.deepEqual(sizeRowsFromCut([{ name: 'M', cutQty: 1333, orderQty: 0 }], 0.0375), [{ sizeLabel: 'M', qty: 49.9875 }]);
  });

  test('until the cut order is generated, the order quantities stand in', () => {
    const uncut = sizes.map((s) => ({ ...s, cutQty: 0 }));
    assert.deepEqual(sizeRowsFromCut(uncut), [
      { sizeLabel: 'S', qty: 100 },
      { sizeLabel: 'M', qty: 200 },
    ]);
  });

  test('a blank, zero or nonsense consumption counts as one per piece', () => {
    for (const per of [null, undefined, 0, -1, Number.NaN]) {
      assert.deepEqual(sizeRowsFromCut(sizes, per)[0], { sizeLabel: 'S', qty: 105 });
    }
  });

  test('an order with no sizes gives no rows', () => {
    assert.deepEqual(sizeRowsFromCut([]), []);
  });
});

describe('the BOM summary', () => {
  test('counts short, complete and not-issued lines from one requirement figure each', () => {
    const s = computeBomSummary([
      { id: 'a', category: 'LABEL', item: 'Size', unit: 'Pcs', requiredQty: 315, issuedQty: 0 },
      { id: 'b', category: 'ACCESSORY', item: 'Hang tag', unit: 'Pcs', requiredQty: 315, issuedQty: 315 },
      { id: 'c', category: 'FABRIC', item: 'Rosetta', unit: 'Met.', requiredQty: 100, issuedQty: 40 },
    ]);
    assert.equal(s.totalItems, 3);
    assert.equal(s.shortItems, 2);
    assert.equal(s.completeItems, 1);
    assert.equal(s.notIssuedItems, 1);
    assert.equal(s.fullyIssued, false);
    assert.equal(s.topShortages[0]!.item, 'Size');
  });
});

test('a bill with a line that has no requirement is not fully issued', () => {
  const base = { id: 'x', category: 'ACCESSORY', item: 'Thread', unit: 'Pcs', unitPriceUsd: null, supplier: null, notes: null, color: null, position: null, description: null, consumptionPerPiece: null } as const;
  const s = computeBomSummary([
    { ...base, requiredQty: 10, issuedQty: 10 },
    { ...base, id: 'y', requiredQty: 0, issuedQty: 0 },
  ] as never);
  assert.equal(s.shortItems, 0);
  assert.equal(s.fullyIssued, false);
  assert.equal(computeBomSummary([{ ...base, requiredQty: 10, issuedQty: 10 }] as never).fullyIssued, true);
});
