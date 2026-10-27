import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cairoDay } from './cairo-day.js';

describe('the factory day a default date lands on', () => {
  test('just after midnight in Cairo is already the next day', () => {
    // 22:30 UTC on the 27th is 01:30 on the 28th in Cairo (UTC+3 in October 2026).
    assert.equal(cairoDay(new Date('2026-10-27T22:30:00Z')).toISOString(), '2026-10-28T00:00:00.000Z');
  });

  test('in winter, UTC+2, the boundary moves with it', () => {
    assert.equal(cairoDay(new Date('2026-01-15T21:59:00Z')).toISOString(), '2026-01-15T00:00:00.000Z');
    assert.equal(cairoDay(new Date('2026-01-15T22:01:00Z')).toISOString(), '2026-01-16T00:00:00.000Z');
  });

  test('the middle of the day is the same day, at UTC midnight', () => {
    assert.equal(cairoDay(new Date('2026-10-27T10:00:00Z')).toISOString(), '2026-10-27T00:00:00.000Z');
  });
});
