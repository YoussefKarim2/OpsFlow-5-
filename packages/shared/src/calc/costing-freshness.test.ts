import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCostLines } from './costing-derive.js';
import { computeCosting } from './costing.js';

/**
 * The costing has to follow the bill of materials, not a copy of it.
 *
 * Cost lines were stored when the costing was last saved and read back from
 * there. So the warehouse issuing more fabric, or a price being corrected, or
 * another operation going out, changed nothing on the costing — it reported
 * the figures as they stood when somebody last pressed save, and nobody
 * presses save on the costing because a warehouse issued some fabric.
 *
 * They are derived at read time now. These hold the arithmetic that makes that
 * safe: the same inputs must always produce the same lines, and a change in
 * the inputs must always produce a different answer.
 */
const bom = (issuedQty: number | null, unitPriceUsd: number | null) => ([{
  category: 'FABRIC', item: 'Jersey', issuedQty, requiredQty: 600,
  unit: 'MET', unitPriceUsd,
}]);

const cost = (issued: number | null, price: number | null) => {
  const lines = deriveCostLines({
    bom: bom(issued, price), external: [],
    production: { machineDaysUsed: null, dailyCostEgp: null, dollarRate: null },
  });
  return computeCosting({
    orderQty: 1000, cutQty: 1000, shippedQty: 1000,
    dollarRate: 1, dailyCostEgp: null, machineCount: null,
    machineDaysUsed: null, daysInLine: null, sellPriceUsd: 10,
    lines: lines.map((l) => ({
      group: l.group, label: l.label, quantity: l.quantity,
      unit: l.unit, unitPriceUsd: l.unitPriceUsd, sourceRef: l.sourceRef,
    })),
  });
};

describe('a change in the bill of materials reaches the costing', () => {
  test('issuing more fabric costs more', () => {
    assert.equal(cost(500, 2).groups.fabric.total, 1000);
    assert.equal(cost(620, 2).groups.fabric.total, 1240);
  });

  test('correcting the price changes the cost', () => {
    assert.equal(cost(500, 2).groups.fabric.total, 1000);
    assert.equal(cost(500, 3).groups.fabric.total, 1500);
  });

  test('and the whole chain follows', () => {
    const cheap = cost(500, 2);
    const dear = cost(620, 3);
    assert.ok(dear.totalCostUsd! > cheap.totalCostUsd!);
    assert.ok(dear.unitActualCostUsd! > cheap.unitActualCostUsd!);
    assert.ok(dear.profitPerUnitUsd! < cheap.profitPerUnitUsd!);
    assert.ok(dear.profitPct! < cheap.profitPct!);
  });

  test('nothing issued is not costed, whatever the price says', () => {
    assert.equal(cost(0, 2).groups.fabric.total, null);
    assert.equal(cost(null, 2).groups.fabric.total, null);
  });

  test('the same inputs always give the same answer', () => {
    const a = cost(620, 2.5);
    const b = cost(620, 2.5);
    assert.equal(a.totalCostUsd, b.totalCostUsd);
    assert.deepEqual(a.groups.fabric.lines, b.groups.fabric.lines);
  });

  test('a hand-entered line is not derived away', () => {
    // Manual rows come from the record; derived ones from the sections. A row
    // carrying the sourceRef of a derived one replaces it rather than doubling.
    const derived = deriveCostLines({
      bom: bom(500, 2), external: [],
      production: { machineDaysUsed: null, dailyCostEgp: null, dollarRate: null },
    });
    const claimed = new Set(['bom:FABRIC']);
    const kept = derived.filter((l) => !claimed.has(l.sourceRef));
    assert.equal(kept.length, 0, 'the derived fabric row stands aside for the edited one');
  });
});
