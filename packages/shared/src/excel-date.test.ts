/**
 * Reading dates out of spreadsheets.
 *
 * The reported crash was:
 *
 *     RangeError: Invalid time value
 *         at Date.toISOString
 *
 * so the first thing asserted here is that nothing this module returns can ever
 * cause it. Everything else is the ways a factory's suppliers actually write
 * dates, plus the ways they write "we don't know yet".
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSpreadsheetDate, parseDateText, safeDate, isValidDate,
  excelSerialToDate, toIsoDateOrNull, toIsoDayOrNull,
} from './excel-date.js';

/** The date as YYYY-MM-DD, or null. Never throws — that is the point. */
const day = (v: unknown) => toIsoDayOrNull(safeDate(v));

describe('the crash cannot happen', () => {
  test('an Invalid Date in a cell comes back as null, not as an Invalid Date', () => {
    const invalid = new Date('not a date');
    assert.ok(invalid instanceof Date, 'precondition: this is what Excel hands us');
    assert.ok(Number.isNaN(invalid.getTime()), 'precondition: and it is invalid');

    const parsed = parseSpreadsheetDate(invalid);
    assert.equal(parsed.value, null);
    // The old code would have thrown on the next line.
    assert.doesNotThrow(() => toIsoDateOrNull(parsed.value));
    assert.equal(toIsoDateOrNull(parsed.value), null);
  });

  test('every kind of rubbish a cell can hold returns null instead of throwing', () => {
    const rubbish: unknown[] = [
      undefined, null, '', '   ', NaN, Infinity, -Infinity,
      new Date('garbage'), {}, [], { formula: 'A1+B1' }, { result: undefined },
      '#VALUE!', '#REF!', 'N/A', 'TBC', 'asap', '???', '--',
      'the third of never', '99/99/9999', '31/02/2026', 0, -1, 1e300,
      true, false, Symbol.iterator.toString(),
    ];

    for (const value of rubbish) {
      assert.doesNotThrow(() => {
        const parsed = parseSpreadsheetDate(value);
        // Whatever comes back, it is either null or genuinely valid.
        if (parsed.value !== null) assert.ok(isValidDate(parsed.value), `${String(value)} produced an invalid Date`);
        toIsoDateOrNull(parsed.value);
        toIsoDayOrNull(parsed.value);
      }, `threw on ${String(value)}`);
    }
  });

  test('one bad cell does not stop the good ones being read', () => {
    // The real failure mode: a workbook where row 40 is nonsense.
    const column = ['2026-09-13', '#VALUE!', '13/09/2026', 'TBC', 45913, 'garbage'];
    const read = column.map((v) => day(v));
    assert.deepEqual(read, [
      '2026-09-13', null, '2026-09-13', null, '2025-09-13', null,
    ]);
  });
});

describe('Excel serial numbers', () => {
  test('the epoch is right — 1 is 31 December 1899, allowing for the 1900 bug', () => {
    assert.equal(toIsoDayOrNull(excelSerialToDate(1)), '1899-12-31');
  });

  test('a real delivery date round-trips', () => {
    // 46278 = 13 September 2026 in Excel's own counting.
    assert.equal(toIsoDayOrNull(excelSerialToDate(46278)), '2026-09-13');
    assert.equal(day(46278), '2026-09-13');
  });

  test('a fractional serial loses its time rather than its date', () => {
    assert.equal(toIsoDayOrNull(excelSerialToDate(46278.75)), '2026-09-13');
  });

  test('a serial stored as text is still read', () => {
    assert.equal(day('46278'), '2026-09-13');
  });

  test('a quantity is not mistaken for a date', () => {
    // 1,972 pieces and style 3091 are numbers in the same workbook. Reading
    // either as a date would be worse than reading nothing.
    assert.equal(day(1972), null);
    assert.equal(day(3091), null);
    assert.equal(day(150), null);
    const parsed = parseSpreadsheetDate(1972);
    assert.match(parsed.problem!, /is a number, not a date/);
  });

  test('an out-of-range serial is refused rather than wrapped', () => {
    assert.equal(excelSerialToDate(0), null);
    assert.equal(excelSerialToDate(-5), null);
    assert.equal(excelSerialToDate(99_999_999), null);
  });
});

describe('the formats suppliers actually send', () => {
  const cases: Array<[string, string]> = [
    ['2026-09-13', '2026-09-13'],
    ['2026/09/13', '2026-09-13'],
    ['2026-09-13T00:00:00.000Z', '2026-09-13'],
    ['13/09/2026', '2026-09-13'],
    ['13-09-2026', '2026-09-13'],
    ['13.09.2026', '2026-09-13'],
    ['13/9/26', '2026-09-13'],
    ['13 Sep 2026', '2026-09-13'],
    ['13 September 2026', '2026-09-13'],
    ['13-Sep-2026', '2026-09-13'],
    ['Sep 13, 2026', '2026-09-13'],
    ['September 13 2026', '2026-09-13'],
    ['13th September 2026', '2026-09-13'],
  ];

  for (const [input, expected] of cases) {
    test(`“${input}” reads as ${expected}`, () => {
      assert.equal(day(input), expected);
    });
  }

  test('a two-digit year pivots at 70', () => {
    assert.equal(day('01/01/26'), '2026-01-01');
    assert.equal(day('01/01/98'), '1998-01-01');
  });
});

describe('an ambiguous date is a question, not a guess', () => {
  test('03/09/2026 offers both readings', () => {
    const parsed = parseDateText('03/09/2026');
    assert.equal(toIsoDayOrNull(parsed.value), '2026-09-03', 'day-first is preferred');
    assert.equal(parsed.confidence, 'MEDIUM', 'and it says so, rather than claiming certainty');
    assert.equal(toIsoDayOrNull(parsed.alternative!.value), '2026-03-09');
  });

  test('the preference can be flipped for an American file', () => {
    const parsed = parseDateText('03/09/2026', false);
    assert.equal(toIsoDayOrNull(parsed.value), '2026-03-09');
    assert.equal(toIsoDayOrNull(parsed.alternative!.value), '2026-09-03');
  });

  test('13/09/2026 is not ambiguous, so it is not reported as such', () => {
    // There is no thirteenth month. Only one reading is possible.
    const parsed = parseDateText('13/09/2026');
    assert.equal(parsed.confidence, 'HIGH');
    assert.equal(parsed.alternative, undefined);
    assert.equal(toIsoDayOrNull(parsed.value), '2026-09-13');
  });

  test('09/13/2026 is unambiguously American, and read that way', () => {
    const parsed = parseDateText('09/13/2026');
    assert.equal(parsed.confidence, 'HIGH');
    assert.equal(toIsoDayOrNull(parsed.value), '2026-09-13');
  });

  test('an ISO date is never ambiguous', () => {
    const parsed = parseDateText('2026-03-09');
    assert.equal(parsed.confidence, 'HIGH');
    assert.equal(parsed.alternative, undefined);
  });
});

describe('a day that does not exist is refused', () => {
  test('31 February does not roll into March', () => {
    // `new Date(2026, 1, 31)` silently becomes 3 March. That is how a delivery
    // date moves by three days and nobody notices.
    assert.equal(day('31/02/2026'), null);
    assert.equal(day('2026-02-31'), null);
  });

  test('31 April and 32 of any month are refused', () => {
    assert.equal(day('31/04/2026'), null);
    assert.equal(day('32/01/2026'), null);
  });

  test('01/13/2026 is not refused — it is unambiguously American', () => {
    // There is no thirteenth month, so day-first is impossible and month-first
    // is the only reading. 13 January, with no question asked.
    const parsed = parseDateText('01/13/2026');
    assert.equal(toIsoDayOrNull(parsed.value), '2026-01-13');
    assert.equal(parsed.confidence, 'HIGH');
  });

  test('29 February is accepted in a leap year and refused otherwise', () => {
    assert.equal(day('29/02/2028'), '2028-02-29');
    assert.equal(day('29/02/2026'), null);
  });
});

describe('“we do not know yet” is an answer, not an error', () => {
  for (const text of ['N/A', 'n/a', 'TBC', 'TBA', 'TBD', 'unknown', 'none', '-', '--', '?', 'ASAP', 'pending']) {
    test(`“${text}” reads as no date, without complaining`, () => {
      const parsed = parseSpreadsheetDate(text);
      assert.equal(parsed.value, null);
      assert.equal(parsed.problem, undefined, 'a placeholder is not a problem to report');
      assert.match(parsed.interpretation, /no date given/);
    });
  }

  test('an Excel error in the cell is reported, because it is a real problem', () => {
    const parsed = parseSpreadsheetDate('#VALUE!');
    assert.equal(parsed.value, null);
    assert.match(parsed.problem!, /#VALUE!/);
  });

  test('genuine nonsense is reported with the text, so it can be found', () => {
    const parsed = parseSpreadsheetDate('sometime after Eid');
    assert.equal(parsed.value, null);
    assert.match(parsed.problem!, /sometime after Eid/);
  });
});

describe('ExcelJS cell shapes', () => {
  test('a formula result is unwrapped', () => {
    assert.equal(day({ formula: "'Order Details'!D26", result: new Date(Date.UTC(2026, 8, 13)) }), '2026-09-13');
  });

  test('a formula with no cached result is nothing, not a crash', () => {
    assert.equal(day({ formula: "'Order Details'!D26", result: undefined }), null);
    assert.equal(day({ sharedFormula: 'D26' }), null);
  });

  test('rich text is joined and then read', () => {
    assert.equal(day({ richText: [{ text: '13 ' }, { text: 'Sep 2026' }] }), '2026-09-13');
  });
});

describe('the confidence a caller can act on', () => {
  test('a real Date and an ISO string are high', () => {
    assert.equal(parseSpreadsheetDate(new Date(Date.UTC(2026, 8, 13))).confidence, 'HIGH');
    assert.equal(parseSpreadsheetDate('2026-09-13').confidence, 'HIGH');
  });

  test('an ambiguous slash date is medium', () => {
    assert.equal(parseSpreadsheetDate('03/09/2026').confidence, 'MEDIUM');
  });

  test('nothing readable is none', () => {
    assert.equal(parseSpreadsheetDate('rubbish').confidence, 'NONE');
    assert.equal(parseSpreadsheetDate(null).confidence, 'NONE');
  });

  test('every result says how it was read, for the review screen', () => {
    for (const v of ['2026-09-13', '03/09/2026', 46264, 'TBC', 'rubbish', null]) {
      const parsed = parseSpreadsheetDate(v);
      assert.ok(parsed.interpretation.length > 0, `${String(v)} has no interpretation`);
    }
  });
});
