import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { costingIsStale, COSTING_STALE_MESSAGE } from './steps.js';

/**
 * The costing autosaves its whole draft, so a save made from a copy somebody
 * else has since changed would undo their work. Each save names the version it
 * was edited from.
 */
describe('saving a costing over somebody else’s', () => {
  const at = new Date('2026-10-27T10:00:00.123Z');

  test('the version the screen loaded may be saved over', () => {
    assert.equal(costingIsStale(at, at.toISOString()), false);
  });

  test('a newer version on the server refuses the save', () => {
    assert.equal(costingIsStale(new Date('2026-10-27T10:00:05.000Z'), at.toISOString()), true);
  });

  test('a costing created since the screen loaded none refuses the save', () => {
    assert.equal(costingIsStale(at, null), true);
  });

  test('the first save of a costing nobody has saved goes through', () => {
    assert.equal(costingIsStale(null, null), false);
    // A version the server does not hold cannot be the one being edited.
    assert.equal(costingIsStale(null, at.toISOString()), true);
  });

  test('a client that sends no version is not refused', () => {
    assert.equal(costingIsStale(at, undefined), false);
  });

  test('the refusal tells the person to reload', () => {
    assert.match(COSTING_STALE_MESSAGE, /Someone else changed this costing/);
    assert.match(COSTING_STALE_MESSAGE, /Reload/);
  });
});
