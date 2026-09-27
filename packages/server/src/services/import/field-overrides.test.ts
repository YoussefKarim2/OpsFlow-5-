/**
 * Values typed on the review screen.
 *
 * They used to be converted with `new Date()` and `Number()` and nothing else.
 * A cleared delivery date or "13/09/2026" reached Prisma as an Invalid Date and
 * failed the import with a 500; the same text as a PO date silently became
 * today; a cut percentage typed as 5 was stored as 500%. Each case below is one
 * of those, reproduced against the real app before it was fixed.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseFieldOverride, applyFieldOverrides } from './extractor.js';
import { ValidationError } from '../../errors.js';

const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

describe('dates typed on the review screen', () => {
  test('a cleared date is no date, not an Invalid Date', () => {
    assert.equal(parseFieldOverride('requiredDeliveryDate', ''), null);
    assert.equal(parseFieldOverride('requiredDeliveryDate', '   '), null);
    assert.equal(parseFieldOverride('requiredDeliveryDate', null), null);
  });

  test('a day-first date is read as the day it names', () => {
    assert.equal(day(parseFieldOverride('requiredDeliveryDate', '13/09/2026')), '2026-09-13');
    // As a PO date this used to become today, with nothing said.
    assert.equal(day(parseFieldOverride('poDate', '13/09/2026')), '2026-09-13');
    assert.equal(day(parseFieldOverride('poDate', '2026-09-13')), '2026-09-13');
  });

  test('"TBC" means no date yet, and is not an error', () => {
    assert.equal(parseFieldOverride('requiredDeliveryDate', 'TBC'), null);
  });

  test('text that is not a date is refused, naming the field', () => {
    assert.throws(
      () => parseFieldOverride('requiredDeliveryDate', 'next tuesday-ish'),
      (err: unknown) => err instanceof ValidationError && /Required Delivery Date/.test(err.message),
    );
  });
});

describe('percentages typed on the review screen', () => {
  test('5, 5% and 0.05 are all five per cent', () => {
    assert.equal(parseFieldOverride('cutPercentage', '5'), 0.05);
    assert.equal(parseFieldOverride('cutPercentage', 5), 0.05);
    assert.equal(parseFieldOverride('cutPercentage', '5%'), 0.05);
    assert.equal(parseFieldOverride('cutPercentage', '0.05'), 0.05);
  });

  test('a decimal comma is a decimal point', () => {
    assert.equal(parseFieldOverride('cutPercentage', '5,50'), 0.055);
  });

  test('an implausible percentage is refused rather than stored', () => {
    assert.throws(() => parseFieldOverride('cutPercentage', '60'), ValidationError);
    assert.throws(() => parseFieldOverride('accessoryPercentage', '-3'), ValidationError);
  });

  test('something that is not a number is refused, naming the field', () => {
    assert.throws(
      () => parseFieldOverride('cutPercentage', 'five'),
      (err: unknown) => err instanceof ValidationError && /Cut Percentage/.test(err.message),
    );
  });
});

describe('numbers and text typed on the review screen', () => {
  test('a price is read the way the file reader reads one', () => {
    assert.equal(parseFieldOverride('pricePerPieceUsd', '5.75'), 5.75);
    assert.equal(parseFieldOverride('pricePerPieceUsd', '$1,250'), 1250);
    assert.equal(parseFieldOverride('pricePerPieceUsd', '5,50'), 5.5);
    assert.throws(() => parseFieldOverride('pricePerPieceUsd', 'n/a'), ValidationError);
  });

  test('text is kept as typed, trimmed', () => {
    assert.equal(parseFieldOverride('poNumber', '  PO-1 '), 'PO-1');
  });
});

describe('applying overrides to an extraction', () => {
  test('the value replaces what was read, and the complaint about it goes', () => {
    const extraction = {
      fields: { poNumber: null, cutPercentage: 0.05 } as Record<string, string | number | Date | null>,
      issues: [
        { level: 'WARNING' as const, field: 'poNumber', sheet: null, cell: null, message: 'No PO number.' },
        { level: 'WARNING' as const, field: 'clientName', sheet: null, cell: null, message: 'No customer.' },
      ],
    };
    applyFieldOverrides(extraction, { poNumber: 'PO-9', cutPercentage: '3' });
    assert.equal(extraction.fields.poNumber, 'PO-9');
    assert.equal(extraction.fields.cutPercentage, 0.03);
    assert.deepEqual(extraction.issues.map((i) => i.field), ['clientName']);
  });
});
