import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleDate, requiredDate, optionalDate } from './form-input.js';

describe('dates a person could mean', () => {
  test('real dates pass, in either form the screens send', () => {
    for (const d of ['2026-10-10', '2026-02-28', '2028-02-29', '2026-10-10T00:00:00.000Z']) assert.ok(isPlausibleDate(d), d);
  });

  test('the year 20026, a 31 February and nonsense are refused', () => {
    for (const d of ['20026-01-01', '2026-02-31', '2026-13-01', '1899-01-01', '2101-01-01', 'soon']) {
      assert.equal(isPlausibleDate(d), false, d);
    }
  });

  test('the shared validators use it', () => {
    assert.equal(requiredDate.safeParse('20026-01-01').success, false);
    assert.equal(optionalDate.safeParse('2026-02-31').success, false);
    assert.equal(optionalDate.safeParse('').success, true, 'blank is still no answer');
  });
});
