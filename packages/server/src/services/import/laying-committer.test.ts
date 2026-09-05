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

import { planMarkerAction, layingRowKey } from './laying-committer.js';

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
