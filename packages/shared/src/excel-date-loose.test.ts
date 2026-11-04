/**
 * The loose last-resort date reading (audit 2026-11-05): `new Date(text)`
 * invented dates nobody wrote — "Sep-26" as 26 September 2001, "Week 38" as
 * 1 January 2038. A date is kept only when the text says its month in words
 * and writes its year in full; anything else is left unread for a person.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpreadsheetDate, safeDate, toIsoDayOrNull } from './excel-date.js';

const day = (v: unknown) => toIsoDayOrNull(safeDate(v));

describe('text that only looks like a date is not read as one', () => {
  for (const text of ['Sep-26', 'Week 38', 'Spring 2027', 'Sept 15', 'Ex-factory 1 10 2026', '1 2', 'PO 12 3', 'W38 2026', 'end of Sept']) {
    test(`“${text}” reads as no date`, () => {
      assert.equal(day(text), null);
      assert.equal(parseSpreadsheetDate(text).confidence, 'NONE');
    });
  }
});

describe('loose text that does state a whole date is still read, as LOW', () => {
  test('a weekday before the date', () => {
    assert.equal(day('Mon 15 Sep 2026'), '2026-09-15');
    assert.equal(parseSpreadsheetDate('Mon 15 Sep 2026').confidence, 'LOW');
  });
  test('an ISO date inside a label', () => {
    assert.equal(day('ETD 2026-09-15'), '2026-09-15');
    assert.equal(parseSpreadsheetDate('ETD 2026-09-15').confidence, 'LOW');
  });
  test('the strict forms are unchanged', () => {
    assert.equal(day('15th Sept 2026'), '2026-09-15');
    assert.equal(day('15.09.26'), '2026-09-15');
    assert.equal(day('2026/09/15'), '2026-09-15');
  });
});
