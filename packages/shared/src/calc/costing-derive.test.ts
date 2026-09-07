/**
 * What Actual Costing may and may not claim.
 *
 * The rule these tests exist to hold is that a missing price produces no line
 * rather than a zero. A zero is a claim that something was free; the absence of
 * a line is a claim that nobody has said yet, and a costing screen that
 * confuses the two is worse than one that shows less.
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deriveCostLines, bomGroupFor, type DerivableInputs } from './costing-derive.js';

const EMPTY: DerivableInputs = {
  bom: [], external: [],
  production: { machineDaysUsed: null, dailyCostEgp: null, dollarRate: null },
};

describe('deriving cost lines from the production sections', () => {
  test('nothing recorded means nothing claimed', () => {
    assert.deepEqual(deriveCostLines(EMPTY), []);
  });

  test('a priced BOM category becomes one traceable line', () => {
    const [line] = deriveCostLines({
      ...EMPTY,
      bom: [
        { category: 'FABRIC', item: 'Jersey', quantity: 100, unit: 'M', unitPriceUsd: 2 },
        { category: 'FABRIC', item: 'Rib', quantity: 50, unit: 'M', unitPriceUsd: 1 },
      ],
    });
    assert.equal(line!.group, 'FABRIC');
    assert.equal(line!.unitPriceUsd, 250);          // 100×2 + 50×1
    assert.equal(line!.sourceRef, 'bom:FABRIC');    // follow it back
  });

  test('a category with one unpriced row produces no line at all', () => {
    // The dangerous case. Summing the rest would show a fabric cost that is
    // silently missing a fabric, and it would look complete.
    assert.deepEqual(deriveCostLines({
      ...EMPTY,
      bom: [
        { category: 'FABRIC', item: 'Jersey', quantity: 100, unit: 'M', unitPriceUsd: 2 },
        { category: 'FABRIC', item: 'Mesh', quantity: 20, unit: 'M', unitPriceUsd: null },
      ],
    }), []);
  });

  test('a missing quantity is as disqualifying as a missing price', () => {
    assert.deepEqual(deriveCostLines({
      ...EMPTY,
      bom: [{ category: 'LABEL', item: 'Neck label', quantity: null, unit: 'PCS', unitPriceUsd: 0.1 }],
    }), []);
  });

  test('fabric is its own group; everything else the BOM holds is an accessory', () => {
    assert.equal(bomGroupFor('FABRIC'), 'FABRIC');
    for (const c of ['LABEL', 'BADGE', 'CARTON', 'THREAD', 'OTHER']) {
      assert.equal(bomGroupFor(c), 'ACCESSORY', `${c} should be an accessory cost`);
    }
  });

  test('outside work is grouped by operation and traceable to it', () => {
    const lines = deriveCostLines({
      ...EMPTY,
      external: [
        { operationType: 'PRINTING', qty: 500, unitPriceUsd: 0.2 },
        { operationType: 'PRINTING', qty: 100, unitPriceUsd: 0.2 },
        { operationType: 'EMBROIDERY', qty: 200, unitPriceUsd: 0.5 },
      ],
    });
    assert.equal(lines.length, 2);
    const printing = lines.find((l) => l.sourceRef === 'external:PRINTING')!;
    assert.equal(printing.unitPriceUsd, 120);        // 500×0.2 + 100×0.2
    assert.equal(printing.group, 'EXTERNAL');
  });

  test('production labour follows the workbook: machine-days × daily cost, converted', () => {
    const [line] = deriveCostLines({
      ...EMPTY,
      production: { machineDaysUsed: 10, dailyCostEgp: 4850, dollarRate: 48.5 },
    });
    assert.equal(line!.group, 'LABOUR');
    assert.equal(line!.quantity, 10);
    assert.equal(line!.unitPriceUsd, 100);           // 4850 / 48.5
    assert.equal(line!.sourceRef, 'production:machine-days');
  });

  test('an incomplete production record invents no rate', () => {
    for (const p of [
      { machineDaysUsed: 10, dailyCostEgp: null, dollarRate: 48.5 },
      { machineDaysUsed: null, dailyCostEgp: 4850, dollarRate: 48.5 },
      { machineDaysUsed: 10, dailyCostEgp: 4850, dollarRate: 0 },
    ]) {
      assert.deepEqual(deriveCostLines({ ...EMPTY, production: p }), []);
    }
  });

  test('every derived line says where it came from', () => {
    const lines = deriveCostLines({
      bom: [{ category: 'FABRIC', item: 'Jersey', quantity: 10, unit: 'M', unitPriceUsd: 2 }],
      external: [{ operationType: 'PRINTING', qty: 10, unitPriceUsd: 1 }],
      production: { machineDaysUsed: 2, dailyCostEgp: 970, dollarRate: 48.5 },
    });
    assert.equal(lines.length, 3);
    for (const l of lines) assert.match(l.sourceRef, /^(bom|external|production):.+/);
  });
});
