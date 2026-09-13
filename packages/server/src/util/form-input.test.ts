import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  relationId, requiredRelationId, optionalDate, optionalNumber,
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
