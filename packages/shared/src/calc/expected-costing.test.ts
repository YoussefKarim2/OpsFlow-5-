import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting } from './costing.js';
import { computeExpectedCosting, sanitiseExpectedTyped, type ExpectedSourceLine } from './expected-costing.js';

const base = {
  orderQty: 300,
  sellPriceUsd: 10,
  dailyCostUsd: 980,
  machineCount: 49,
  lineMachines: 14,
  targetPerDay: 150,
  lines: <ExpectedSourceLine[]>[
    { group: 'FABRIC' as const, label: 'Jersey', unit: 'KG', ref: 'bom:FABRIC:a', plannedQty: 90, unitPriceUsd: 5 },
    { group: 'ACCESSORY' as const, label: 'Label', unit: 'PCS', ref: 'bom:ACCESSORY:b', plannedQty: 300, unitPriceUsd: 0.1 },
    { group: 'EXTERNAL' as const, label: 'Sublimation', unit: 'PCS', ref: 'external:SUBLIMATION', plannedQty: 300, unitPriceUsd: 0.5 },
  ],
};

describe('expected costing', () => {
  test('everything from the order: same engine as the actual costing', () => {
    const r = computeExpectedCosting(base);
    assert.equal(r.daysInLine, 2);
    assert.equal(r.fabricCostUsd, 450);
    assert.equal(r.accessoryCostUsd, 30);
    assert.equal(r.externalCostUsd, 150);
    // Maestro C.M: (980/49) × (14 × 2) ÷ 150 × 300
    const actual = computeCosting({
      orderQty: 300, cutQty: 300, shippedQty: 300, firstDegreeQty: 300, dailyCostUsd: 980, machineCount: 49,
      machineDaysUsed: null, daysInLine: 2, lineMachineQty: 14, targetPerDay: 150, sellPriceUsd: 10, lines: [],
    });
    assert.equal(r.cmCostUsd, actual.cmCostUsd);
    assert.ok(Math.abs(r.cmCostUsd! - 1120) < 1e-9);
    assert.ok(Math.abs(r.totalCostUsd! - 1750) < 1e-9);
    assert.ok(Math.abs(r.unitCostUsd! - 1750 / 300) < 1e-9);
    assert.ok(Math.abs(r.profitPerUnitUsd! - (10 - 1750 / 300)) < 1e-9);
    assert.deepEqual(r.missing, []);
    assert.equal(r.sellPriceUsd.source, 'auto');
  });

  test('a missing figure waits for a typed one, and the typed one fills it', () => {
    const fabric: ExpectedSourceLine = { group: 'FABRIC', label: 'Jersey', unit: 'KG', ref: 'bom:FABRIC:a', plannedQty: 90, unitPriceUsd: null };
    const gaps = { ...base, targetPerDay: null, lines: [fabric] };
    const empty = computeExpectedCosting(gaps);
    assert.equal(empty.cmCostUsd, null);
    assert.equal(empty.lines[0]!.cost, null);
    assert.deepEqual(empty.missing, ['the target per day', '1 unit price']);
    const filled = computeExpectedCosting({ ...gaps, typed: { targetPerDay: 150, 'price:bom:FABRIC:a': 5 } });
    assert.equal(filled.targetPerDay.source, 'typed');
    assert.equal(filled.lines[0]!.price.source, 'typed');
    assert.equal(filled.lines[0]!.cost, 450);
    assert.deepEqual(filled.missing, []);
  });

  test("a typed figure wins over the order's, which is kept to put back", () => {
    const r = computeExpectedCosting({ ...base, typed: { sellPriceUsd: 99, 'price:bom:FABRIC:a': 1 } });
    assert.deepEqual(r.sellPriceUsd, { value: 99, source: 'typed', base: 10 });
    assert.deepEqual(r.lines[0]!.price, { value: 1, source: 'typed', base: 5 });
    assert.equal(r.fabricCostUsd, 90);
  });

  test('calculated figures can be typed over too, and the rest follows', () => {
    const days = computeExpectedCosting({ ...base, typed: { daysInLine: 4 } });
    assert.equal(days.daysInLine, 4);
    assert.deepEqual(days.derived.daysInLine, { value: 4, source: 'typed', base: 2 });
    assert.ok(Math.abs(days.cmCostUsd! - 2240) < 1e-9);

    const cm = computeExpectedCosting({ ...base, typed: { cmPerPieceUsd: 2 } });
    assert.equal(cm.cmCostUsd, 600);
    assert.ok(Math.abs(cm.derived.cmPerPieceUsd.base! - 1120 / 300) < 1e-9);
    assert.ok(Math.abs(cm.totalCostUsd! - (450 + 30 + 150 + 600)) < 1e-9);

    const ext = computeExpectedCosting({ ...base, typed: { externalCostUsd: 60, fabricCostUsd: 400 } });
    assert.equal(ext.externalCostUsd, 60);
    assert.equal(ext.derived.externalCostUsd.base, 150);
    assert.equal(ext.fabricCostUsd, 400);
    assert.ok(Math.abs(ext.totalCostUsd! - (400 + 30 + 60 + 1120)) < 1e-9);

    const total = computeExpectedCosting({ ...base, typed: { totalCostUsd: 3000 } });
    assert.equal(total.unitCostUsd, 10);
    assert.equal(total.profitPerUnitUsd, 0);
    assert.ok(Math.abs(total.derived.totalCostUsd.base! - 1750) < 1e-9);

    const loss = computeExpectedCosting({ ...base, typed: { profitPerUnitUsd: -1 } });
    assert.equal(loss.profitPerUnitUsd, -1);
    assert.equal(loss.derived.profitPerUnitUsd.source, 'typed');
  });

  test('other costs join the total', () => {
    const r = computeExpectedCosting({ ...base, typed: { otherCostUsd: 50 } });
    assert.ok(Math.abs(r.totalCostUsd! - 1800) < 1e-9);
  });

  test('sanitising drops unknown keys and bad numbers', () => {
    assert.deepEqual(
      sanitiseExpectedTyped({ sellPriceUsd: '7.5', bogus: 3, 'price:x': -1, 'qty:y': 'abc', 'qty:z': 4, targetPerDay: Infinity }),
      { sellPriceUsd: 7.5, 'qty:z': 4 },
    );
    assert.deepEqual(sanitiseExpectedTyped({ profitPct: -5, totalCostUsd: -5, daysInLine: 3 }), { profitPct: -5, daysInLine: 3 });
    assert.deepEqual(sanitiseExpectedTyped(null), {});
    assert.deepEqual(sanitiseExpectedTyped([1]), {});
  });
});
