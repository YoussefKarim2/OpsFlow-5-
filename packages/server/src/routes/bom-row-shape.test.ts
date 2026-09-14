import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

/**
 * The bill of materials, as the editor actually sends it.
 *
 * Saving was broken for anyone who left a column blank — which is nearly
 * everyone. The editor hands back the row the GET gave it, and the GET returns
 * `null` for an empty description, colour, supplier or price. The schema used
 * `z.string().optional()`, which accepts `undefined` and rejects `null`, so the
 * request failed validation with 422 — and the mutation had no error handler,
 * so the Save button finished and nothing happened at all.
 *
 * These mirror the server's row schema so the shape cannot drift back.
 */
const bomItemSchema = z.object({
  category: z.enum(['FABRIC', 'ACCESSORY', 'BADGE', 'OTHER']),
  position: z.string().nullish(),
  item: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  colorId: z.string().nullish(),
  colorText: z.string().max(200).nullish(),
  consumptionPerPiece: z.number().nonnegative().nullish(),
  requiredQty: z.number().nonnegative(),
  unit: z.string().min(1).max(40),
  unitPriceUsd: z.number().nonnegative().max(999_999.9999).nullish(),
  supplier: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
});

describe('a bill-of-material row as the screen sends it', () => {
  test('a row with every optional field null is accepted', () => {
    // The exact payload that produced a silent failure.
    assert.doesNotThrow(() => bomItemSchema.parse({
      category: 'FABRIC', item: 'Rosetta', description: null, colorText: null,
      unit: 'M', requiredQty: 100, unitPriceUsd: null, supplier: null, notes: null,
    }));
  });

  test('a fully filled row is still accepted', () => {
    assert.doesNotThrow(() => bomItemSchema.parse({
      category: 'ACCESSORY', item: 'Poly bag', description: 'Clear', colorText: 'White',
      unit: 'Pcs', requiredQty: 2084, unitPriceUsd: 0.03, supplier: 'Acme', notes: 'urgent',
    }));
  });

  test('omitting the optional fields entirely still works', () => {
    assert.doesNotThrow(() => bomItemSchema.parse({
      category: 'FABRIC', item: 'Rosetta', unit: 'M', requiredQty: 100,
    }));
  });

  test('an item with no name is still refused', () => {
    // The one rule worth keeping: a nameless line helps nobody on the shop floor.
    assert.throws(() => bomItemSchema.parse({
      category: 'FABRIC', item: '', unit: 'M', requiredQty: 1,
    }));
  });

  test('a price beyond the column ceiling is refused by name', () => {
    assert.throws(() => bomItemSchema.parse({
      category: 'FABRIC', item: 'Rosetta', unit: 'M', requiredQty: 1, unitPriceUsd: 1e15,
    }));
  });
});
