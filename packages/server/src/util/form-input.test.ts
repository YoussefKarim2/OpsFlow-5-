import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  relationId, requiredRelationId, optionalDate, optionalNumber, shortText, longText, money,
} from './form-input.js';

/**
 * Every one of these corresponds to a save that failed in practice.
 *
 * Order Details sends its whole form on every save, so a field nobody has
 * filled in is not absent - it is present and empty. Twelve realistic saves
 * were tried against the real API and twelve failed, all on this.
 */
describe('input as a form actually sends it', () => {
  describe('an optional relation', () => {
    const schema = z.object({ coordinatorId: relationId });

    test('an unchosen select clears the relation instead of breaking the save', () => {
      // "" was reaching Postgres as an id, and every save failed with a
      // foreign-key error on an order that had nothing wrong with it.
      assert.equal(schema.parse({ coordinatorId: '' }).coordinatorId, null);
    });

    test('a chosen value is kept', () => {
      assert.equal(schema.parse({ coordinatorId: 'user_1' }).coordinatorId, 'user_1');
    });

    test('an absent field stays absent, so it is not overwritten', () => {
      // undefined is what Prisma reads as "leave this column alone".
      assert.equal(schema.parse({}).coordinatorId, undefined);
    });

    test('an explicit null still clears it', () => {
      assert.equal(schema.parse({ coordinatorId: null }).coordinatorId, null);
    });
  });

  describe('a required relation', () => {
    const schema = z.object({ clientId: requiredRelationId });

    test('"" leaves it unchanged rather than clearing something mandatory', () => {
      // An order must have a client; a blank means the form had none to offer.
      assert.equal(schema.parse({ clientId: '' }).clientId, undefined);
    });

    test('a real id passes through', () => {
      assert.equal(schema.parse({ clientId: 'client_1' }).clientId, 'client_1');
    });
  });

  describe('a date the user cleared', () => {
    const schema = z.object({ poDate: optionalDate });

    test('"" is no answer, not an invalid date', () => {
      assert.equal(schema.parse({ poDate: '' }).poDate, undefined);
    });

    test('a real date passes through untouched', () => {
      assert.equal(schema.parse({ poDate: '2026-01-01' }).poDate, '2026-01-01');
    });
  });

  describe('a number the user emptied', () => {
    const schema = z.object({ price: optionalNumber(z.number().nonnegative()) });

    test('NaN arrives as null through JSON and must not fail the save', () => {
      // Number('abc') is NaN, and JSON.stringify writes null.
      assert.equal(schema.parse({ price: null }).price, undefined);
    });

    test('an empty string is treated the same way', () => {
      assert.equal(schema.parse({ price: '' }).price, undefined);
    });

    test('zero is a real answer and is kept', () => {
      assert.equal(schema.parse({ price: 0 }).price, 0);
    });

    test('a real number is kept', () => {
      assert.equal(schema.parse({ price: 5.75 }).price, 5.75);
    });

    test('a genuinely invalid number is still refused', () => {
      // Forgiving about blanks must not mean accepting nonsense.
      assert.throws(() => schema.parse({ price: -1 }));
    });
  });
});

describe('free text with a ceiling', () => {
  test('an ordinary value passes', () => {
    const schema = z.object({ orderName: shortText() });
    assert.equal(schema.parse({ orderName: 'Florida T Shirt' }).orderName, 'Florida T Shirt');
  });

  test('a pasted novel is refused rather than stored', () => {
    // A 100,000-character order name was accepted and persisted. It renders
    // into every list, every email and every PDF that mentions the order.
    const schema = z.object({ orderName: shortText() });
    assert.throws(() => schema.parse({ orderName: 'A'.repeat(100_000) }));
  });

  test('an empty string still means "not answered"', () => {
    const schema = z.object({ orderName: shortText() });
    assert.equal(schema.parse({ orderName: '' }).orderName, undefined);
  });

  test('notes and addresses are allowed to be genuinely long', () => {
    const schema = z.object({ notes: longText() });
    assert.equal(schema.parse({ notes: 'x'.repeat(5000) }).notes!.length, 5000);
  });

  test('but not unbounded', () => {
    const schema = z.object({ notes: longText() });
    assert.throws(() => schema.parse({ notes: 'x'.repeat(100_000) }));
  });
});

describe('values the database itself would refuse', () => {
  test('a price with too many digits is refused by name, not by a 500', () => {
    // pricePerPieceUsd is Decimal(10,4): 999,999.9999 is the ceiling. Above it
    // Postgres raises 22003 and the user was told the server had broken.
    const schema = z.object({ price: money() });
    assert.equal(schema.parse({ price: 999_999.9999 }).price, 999_999.9999);
    assert.throws(() => schema.parse({ price: 1e15 }));
    assert.throws(() => schema.parse({ price: 1e308 }));
  });

  test('an ordinary price still passes', () => {
    const schema = z.object({ price: money() });
    assert.equal(schema.parse({ price: 5.75 }).price, 5.75);
    assert.equal(schema.parse({ price: 0 }).price, 0);
  });

  test('a pasted NUL byte is stripped rather than refused', () => {
    // Invisible, arrives from spreadsheets and PDFs, and Postgres rejects it
    // outright (22021). The user cannot see it, so they cannot remove it.
    const schema = z.object({ name: shortText() });
    const withNul = 'abc' + String.fromCharCode(0) + 'def';
    assert.equal(schema.parse({ name: withNul }).name, 'abcdef');
  });

  test('stripping a NUL does not disturb ordinary text', () => {
    const schema = z.object({ name: shortText() });
    for (const v of ['Florida T Shirt', 'قميص قطن', 'Order 🧵', 'He said "hi"']) {
      assert.equal(schema.parse({ name: v }).name, v);
    }
  });

  test('a string that is only a NUL becomes "not answered"', () => {
    const schema = z.object({ name: shortText() });
    assert.equal(schema.parse({ name: String.fromCharCode(0) }).name, undefined);
  });
});
