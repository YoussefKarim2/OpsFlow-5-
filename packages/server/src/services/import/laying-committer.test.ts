/**
 * The Keep / Replace / Add-new rule for a Laying & Marking re-import.
 *
 * Pulled out of `commitLayingImport` as `planMarkerAction` specifically so
 * this — the one rule a coordinator's data actually depends on — is testable
 * without a database. The rule that matters most: an unresolved conflict
 * must never overwrite existing data.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planMarkerAction, layingRowKey, resolveLayingRows, wholeLayers } from './laying-committer.js';

const EXISTING = { id: 'marker-1' };

describe('what to do with an imported row', () => {
  test('nothing existing at that key is always a create', () => {
    assert.deepEqual(planMarkerAction(undefined, undefined), { kind: 'CREATE' });
    assert.deepEqual(planMarkerAction(undefined, 'REPLACE'), { kind: 'CREATE' });
  });

  test('a match with no resolution is skipped, never overwritten', () => {
    // The coordinator never saw this conflict (e.g. a re-run of an old job),
    // so the safe default is to leave the existing row untouched.
    assert.deepEqual(planMarkerAction(EXISTING, undefined), { kind: 'SKIP', existingId: 'marker-1' });
  });

  test('an explicit KEEP is also a skip', () => {
    assert.deepEqual(planMarkerAction(EXISTING, 'KEEP'), { kind: 'SKIP', existingId: 'marker-1' });
  });

  test('REPLACE updates the matched row in place', () => {
    assert.deepEqual(planMarkerAction(EXISTING, 'REPLACE'), { kind: 'UPDATE', existingId: 'marker-1' });
  });

  test('ADD_NEW creates a second row rather than touching the match', () => {
    assert.deepEqual(planMarkerAction(EXISTING, 'ADD_NEW'), { kind: 'CREATE' });
  });
});

describe('the key a conflict is matched on', () => {
  test('a marker number is the key when the sheet has one', () => {
    assert.equal(layingRowKey({ markerNumber: 'M1', rowNumber: 4 }), 'marker:M1');
  });

  test('falls back to the row position when the sheet has no marker numbers', () => {
    assert.equal(layingRowKey({ markerNumber: null, rowNumber: 4 }), 'row:4');
  });
});

describe('a marker number used more than once in one sheet', () => {
  const rows = [
    { markerNumber: 'M1', rowNumber: 1 },
    { markerNumber: 'M1', rowNumber: 2 },
    { markerNumber: 'M2', rowNumber: 3 },
    { markerNumber: 'M1', rowNumber: 4 },
  ];

  test('each appearance has its own key, so each gets its own Keep/Replace', () => {
    const keys = resolveLayingRows(rows, []).map((r) => r.key);
    assert.deepEqual(keys, ['marker:M1', 'marker:M1#2', 'marker:M2', 'marker:M1#3']);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('the n-th appearance collides with the n-th existing lay of that number, not the same one each time', () => {
    const existing = [
      { id: 'b', markerNumber: 'M1', position: 5 },
      { id: 'a', markerNumber: 'M1', position: 2 },
      { id: 'c', markerNumber: 'M2', position: 3 },
    ];
    const resolved = resolveLayingRows(rows, existing);
    assert.deepEqual(resolved.map((r) => r.existing?.id), ['a', 'b', 'c', undefined]);
  });

  test('a row without a marker number is still matched by position', () => {
    const resolved = resolveLayingRows([{ markerNumber: null, rowNumber: 2 }], [{ id: 'x', markerNumber: null, position: 1 }]);
    assert.equal(resolved[0]!.key, 'row:2');
    assert.equal(resolved[0]!.existing?.id, 'x');
  });
});

describe('layer counts the Marker table can hold', () => {
  test('a fraction is rounded to the nearest whole layer, not truncated', () => {
    assert.equal(wholeLayers(139.5), 140);
    assert.equal(wholeLayers(139.4), 139);
  });

  test('missing or nonsense is zero', () => {
    assert.equal(wholeLayers(null), 0);
    assert.equal(wholeLayers(Number.NaN), 0);
    assert.equal(wholeLayers(-3), 0);
  });
});
