import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting, type CostingInput } from './costing.js';
import { fmtMoney, NOT_CALCULATED } from './num.js';

/**
 * Cut-and-make, to the formula the factory uses.
 *
 *   Machine Cost         = Daily Cost ÷ All Factory Machines
 *   Machine Already Used = Line Machines Qty × Days in Line
 *   C.M Cost             = (Machine Cost × Machine Already Used)
 *                          ÷ Productivity Rate
 *                          × 1st Degree Qty
 *
 * The first two are worked out from figures the sheet already holds, so nobody
 * multiplies or divides anything by hand. Everything is in EGP, as the daily
 * cost is, and converted once at the stored rate — the Total column is in
 * dollars and mixing the two is what the source workbook does wrong.
 */

/** A costing with the rate set to 1, so EGP and USD are the same number. */
const base = (over: Partial<CostingInput> = {}): CostingInput => ({
  orderQty: 1000, cutQty: 1000, shippedQty: 1000,
  dollarRate: 1, dailyCostEgp: null, machineCount: null,
  machineDaysUsed: null, daysInLine: null, lineMachineQty: null,
  firstDegreeQty: null, secondDegreeQty: null,
  sellPriceUsd: null, lines: [], ...over,
});

describe('the C.M formula, on the figures given', () => {
  test('machine cost 10, machine-days 5, productivity 2, 1st degree 100 → 2,500', () => {
    // Stated directly: every input pinned, so only the final arithmetic is
    // under test. ((10 × 5) ÷ 2) × 100.
    const r = computeCosting(base({
      dailyCostEgp: 100, machineCount: 10,          // machine cost 10
      firstDegreeQty: 100,
      overrides: { machineDaysUsed: 5, productivityRate: 2 },
    }));
    assert.equal(r.machineCostEgpPerDay, 10);
    assert.equal(r.machineDaysUsed, 5);
    assert.equal(r.productivityRate, 2);
    assert.equal(r.cmCostUsd, 2500);
  });

  test('the whole chain: 100 ÷ 10, 2 × 5, then ((10 × 10) ÷ 2) × 100 → 5,000', () => {
    const r = computeCosting(base({
      dailyCostEgp: 100, machineCount: 10,
      lineMachineQty: 2, daysInLine: 5,
      firstDegreeQty: 100,
      overrides: { productivityRate: 2 },
    }));
    assert.equal(r.machineCostEgpPerDay, 10, 'Daily Cost ÷ All Factory Machines');
    assert.equal(r.machineDaysUsed, 10, 'Line Machines Qty × Days in Line');
    assert.equal(r.cmCostUsd, 5000);
  });

  test('machine-days is worked out, not asked for', () => {
    const r = computeCosting(base({ lineMachineQty: 12, daysInLine: 11 }));
    assert.equal(r.machineDaysUsed, 132);
  });

  test('a stored figure is kept when the line and days are not recorded', () => {
    // An order costed before this existed does not silently lose its figure.
    const r = computeCosting(base({ machineDaysUsed: 130 }));
    assert.equal(r.machineDaysUsed, 130);
  });

  test('typing over machine-days still wins, as everywhere on this sheet', () => {
    const r = computeCosting(base({
      lineMachineQty: 2, daysInLine: 5, overrides: { machineDaysUsed: 40 },
    }));
    assert.equal(r.machineDaysUsed, 40);
    assert.ok(r.overridden.includes('machineDaysUsed'));
    assert.equal(r.calculated.machineDaysUsed, 10, 'and the worked-out figure is kept');
  });
});

describe('every input moves C.M, and nothing else does', () => {
  const settled = base({
    dailyCostEgp: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5,
    firstDegreeQty: 100, overrides: { productivityRate: 2 },
  });
  const cm = (over: Partial<CostingInput>) => computeCosting({ ...settled, ...over }).cmCostUsd;

  test('doubling the daily cost doubles it', () => {
    assert.equal(cm({ dailyCostEgp: 200 }), 10_000);
  });

  test('doubling the factory machines halves it', () => {
    assert.equal(cm({ machineCount: 20 }), 2500);
  });

  test('doubling the line machines doubles it', () => {
    assert.equal(cm({ lineMachineQty: 4 }), 10_000);
  });

  test('doubling the days in line doubles it', () => {
    assert.equal(cm({ daysInLine: 10 }), 10_000);
  });

  test('doubling the productivity rate halves it', () => {
    assert.equal(cm({ overrides: { productivityRate: 4 } }), 2500);
  });

  test('doubling the 1st degree quantity doubles it', () => {
    assert.equal(cm({ firstDegreeQty: 200 }), 10_000);
  });

  test('the sell price and the order quantity do not touch it', () => {
    assert.equal(cm({ sellPriceUsd: 99 }), 5000);
    assert.equal(cm({ orderQty: 999_999 }), 5000);
  });
});

describe('C.M when something it needs is missing', () => {
  const partial = base({
    dailyCostEgp: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5, firstDegreeQty: 100,
  });

  test('a productivity rate of zero divides by nothing', () => {
    const r = computeCosting({ ...partial, overrides: { productivityRate: 0 } });
    assert.equal(r.cmCostUsd, null);
    assert.equal(fmtMoney(r.cmCostUsd), NOT_CALCULATED);
    assert.match(r.waiting.cmCostUsd!, /productivity rate/);
  });

  test('no productivity rate at all says so', () => {
    // Nothing cut, so the rate cannot be worked out either.
    const r = computeCosting({ ...partial, cutQty: 0 });
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd!, /productivity rate/);
  });

  test('no 1st degree quantity says so', () => {
    const r = computeCosting({ ...partial, firstDegreeQty: null, overrides: { productivityRate: 2 } });
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd!, /1st degree/);
  });

  test('no machine cost says so', () => {
    const r = computeCosting({ ...partial, dailyCostEgp: null, overrides: { productivityRate: 2 } });
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd!, /machine cost/);
  });

  test('no line or days, and nothing stored, says so', () => {
    const r = computeCosting({
      ...partial, lineMachineQty: null, daysInLine: null, overrides: { productivityRate: 2 },
    });
    assert.equal(r.machineDaysUsed, null);
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd!, /line machines and days/);
  });

  test('nothing can ever render as an error code', () => {
    const hostile: Array<Partial<CostingInput>> = [
      { machineCount: 0 }, { dailyCostEgp: 0 }, { lineMachineQty: 0 }, { daysInLine: 0 },
      { firstDegreeQty: 0 }, { cutQty: 0 }, { dollarRate: 0 }, { dollarRate: null },
      { overrides: { productivityRate: 0 } },
    ];
    for (const over of hostile) {
      const r = computeCosting({ ...partial, ...over });
      assert.ok(r.cmCostUsd == null || Number.isFinite(r.cmCostUsd), `cm was ${r.cmCostUsd}`);
      assert.ok(r.totalCostUsd == null || Number.isFinite(r.totalCostUsd));
      assert.doesNotMatch(fmtMoney(r.cmCostUsd), /NaN|Infinity|#DIV/);
    }
  });
});

describe('the Total follows C.M', () => {
  const withFabric = base({
    dailyCostEgp: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5,
    firstDegreeQty: 100, overrides: { productivityRate: 2 },
    lines: [{ group: 'FABRIC', label: 'Jersey', quantity: 100, unit: 'M', unitPriceUsd: 3 }],
  });

  test('the total is the sections plus C.M', () => {
    const r = computeCosting(withFabric);
    assert.equal(r.groups.fabric.total, 300);
    assert.equal(r.cmCostUsd, 5000);
    assert.equal(r.totalCostUsd, 5300);
  });

  test('changing a C.M input moves the total, and the unit cost with it', () => {
    const r = computeCosting({ ...withFabric, daysInLine: 10 });   // C.M doubles
    assert.equal(r.cmCostUsd, 10_000);
    assert.equal(r.totalCostUsd, 10_300);
    assert.equal(r.unitActualCostUsd, 10_300 / 1000);
  });

  test('when C.M cannot be worked out the total is still the rest of the costs', () => {
    const r = computeCosting({ ...withFabric, overrides: { productivityRate: 0 } });
    assert.equal(r.cmCostUsd, null);
    assert.equal(r.totalCostUsd, 300, 'fabric alone, not zero and not null');
  });

  test('the dollar rate converts C.M once, and only C.M', () => {
    const r = computeCosting({ ...withFabric, dollarRate: 50 });
    assert.equal(r.cmCostUsd, 100, '5,000 EGP at 50 to the dollar');
    assert.equal(r.groups.fabric.total, 300, 'material prices are already in dollars');
    assert.equal(r.totalCostUsd, 400);
  });
});
