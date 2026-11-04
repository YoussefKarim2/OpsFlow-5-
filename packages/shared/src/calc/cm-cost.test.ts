import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting, type CostingInput } from './costing.js';
import { fmtMoney, NOT_CALCULATED } from './num.js';

/**
 * C.M as the factory's template works it out — `'Actual Costing'!K39` of
 * "Final Template Po (Maestro)":
 *
 *   ((Machine Cost × Machine Already Used) ÷ Productivity rate) × 1st Degree Qty
 *
 * where Machine Cost = Daily Cost ÷ All F. Machines (H9), Machine Already Used
 * = Line Machines × Days in line (H12), and the Productivity rate is the
 * Production sheet's "Target Production / Day" (L15 = 'Production Follow up'!J13).
 *
 * Everything is in dollars, as every figure in OpsFlow is.
 */

/** A costing with nothing recorded beyond the quantities. */
const base = (over: Partial<CostingInput> = {}): CostingInput => ({
  orderQty: 1000, cutQty: 1000, shippedQty: 1000,
  dailyCostUsd: null, machineCount: null,
  machineDaysUsed: null, daysInLine: null, lineMachineQty: null,
  firstDegreeQty: null, secondDegreeQty: null,
  sellPriceUsd: null, lines: [], ...over,
});

describe('the C.M formula, on the figures given', () => {
  test('machine cost 10, machine-days 5, productivity 2, 1st degree 100 → 2,500', () => {
    // Stated directly: every input pinned, so only the final arithmetic is
    // under test. ((10 × 5) ÷ 2) × 100.
    const r = computeCosting(base({
      dailyCostUsd: 100, machineCount: 10,          // machine cost 10
      firstDegreeQty: 100,
      overrides: { machineDaysUsed: 5, productivityRate: 2 },
    }));
    assert.equal(r.machineCostPerDay, 10);
    assert.equal(r.machineDaysUsed, 5);
    assert.equal(r.productivityRate, 2);
    assert.equal(r.cmCostUsd, 2500);
  });

  test('the whole chain: 100 ÷ 10, 2 × 5, 10 ÷ 10, target 500, then ((10 × 10) ÷ 500) × 100 → 20', () => {
    const r = computeCosting(base({
      dailyCostUsd: 100, machineCount: 10,
      lineMachineQty: 2, daysInLine: 5,
      cutQty: 1000, firstDegreeQty: 100, targetPerDay: 500,
    }));
    assert.equal(r.machineCostPerDay, 10, 'Daily Cost ÷ All Factory Machines');
    assert.equal(r.machineDaysUsed, 10, 'Line Machines Qty × Days in Line');
    assert.equal(r.workDays, 1, 'Machine Already Used ÷ All Factory Machines');
    assert.equal(r.productivityRate, 500, "the Production step's target per day");
    assert.equal(r.cmCostUsd, 20, '((Machine Cost × Machine Already Used) ÷ Productivity rate) × 1st Degree Qty');
  });

  test("the factory's own sheet: $2,503 a day, 49 machines, 13 on the line for 11 days, target 500, 1,092 passed", () => {
    const r = computeCosting(base({
      dailyCostUsd: 2503, machineCount: 49, daysInLine: 11,
      cutQty: 1147, firstDegreeQty: 1092, planLineMachineQty: 13, targetPerDay: 500,
    }));
    const expected = (((2503 / 49) * (13 * 11)) / 500) * 1092;
    assert.ok(Math.abs(r.cmCostUsd! - expected) < 1e-6, `${r.cmCostUsd} should be ${expected}`);
    assert.equal(r.lineMachineQty, 13);
    assert.equal(r.lineMachineSource, 'production');
    assert.equal(r.machineDaysUsed, 143);
  });

  test('machine-days is worked out, not asked for', () => {
    const r = computeCosting(base({ lineMachineQty: 12, daysInLine: 11 }));
    assert.equal(r.machineDaysUsed, 132);
  });

  test('a stored figure is kept when the line and days are not recorded', () => {
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
  // Machine cost 10, machine-days 10, target 500 → C.M 20.
  const settled = base({
    dailyCostUsd: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5,
    cutQty: 1000, firstDegreeQty: 100, targetPerDay: 500,
  });
  const cm = (over: Partial<CostingInput>) => computeCosting({ ...settled, ...over }).cmCostUsd;

  test('doubling the daily cost doubles it', () => { assert.equal(cm({ dailyCostUsd: 200 }), 40); });
  test('doubling the factory machines halves it', () => { assert.equal(cm({ machineCount: 20 }), 10); });
  test('doubling the line machines doubles it', () => { assert.equal(cm({ lineMachineQty: 4 }), 40); });
  test('doubling the days in line doubles it', () => { assert.equal(cm({ daysInLine: 10 }), 40); });
  test('doubling the target halves it', () => { assert.equal(cm({ targetPerDay: 1000 }), 10); });
  test('typing twice the productivity rate halves it', () => { assert.equal(cm({ overrides: { productivityRate: 1000 } }), 10); });
  test('doubling the 1st degree quantity doubles it', () => { assert.equal(cm({ firstDegreeQty: 200 }), 40); });
  test('the cut, the sell price and the order quantity do not touch it', () => {
    assert.equal(cm({ cutQty: 2000 }), 20);
    assert.equal(cm({ sellPriceUsd: 99 }), 20);
    assert.equal(cm({ orderQty: 999_999 }), 20);
  });
});

describe('C.M when something it needs is missing', () => {
  const partial = base({ dailyCostUsd: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5, firstDegreeQty: 100 });

  test('no target on the Production step says so', () => {
    const r = computeCosting(partial);
    assert.equal(r.productivityRate, null);
    assert.equal(r.cmCostUsd, null);
    assert.equal(fmtMoney(r.cmCostUsd), NOT_CALCULATED);
    assert.match(r.waiting.cmCostUsd!, /target production per day/);
  });

  test('a productivity rate of zero divides by nothing', () => {
    const r = computeCosting({ ...partial, overrides: { productivityRate: 0 } });
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd!, /productivity rate/);
  });

  test('no 1st degree quantity says so', () => {
    const r = computeCosting({ ...partial, firstDegreeQty: null, targetPerDay: 500 });
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd!, /1st degree/);
  });

  test('no daily cost says so', () => {
    const r = computeCosting({ ...partial, dailyCostUsd: null, targetPerDay: 500 });
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd!, /daily cost/);
  });

  test('no line or days, and nothing stored, says so', () => {
    const r = computeCosting({ ...partial, lineMachineQty: null, daysInLine: null, targetPerDay: 500 });
    assert.equal(r.machineDaysUsed, null);
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd!, /line machines and days/);
  });

  test('a typed productivity rate is enough, with the line and days', () => {
    const r = computeCosting({ ...partial, overrides: { productivityRate: 2 } });
    assert.equal(r.cmCostUsd, 5000, '((10 × 10) ÷ 2) × 100');
  });

  test('nothing can ever render as an error code', () => {
    for (const over of [
      { machineCount: 0 }, { dailyCostUsd: 0 }, { targetPerDay: 0 }, { firstDegreeQty: 0 },
      { overrides: { productivityRate: 0 } }, { overrides: { machineDaysUsed: 0 } },
    ] as Partial<CostingInput>[]) {
      const r = computeCosting({ ...partial, targetPerDay: 500, ...over });
      assert.ok(r.cmCostUsd == null || Number.isFinite(r.cmCostUsd), `cm was ${r.cmCostUsd}`);
      assert.ok(r.totalCostUsd == null || Number.isFinite(r.totalCostUsd));
      assert.doesNotMatch(fmtMoney(r.cmCostUsd), /NaN|Infinity|#DIV/);
    }
  });
});

describe('the Total follows C.M', () => {
  const withFabric = base({
    dailyCostUsd: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5,
    firstDegreeQty: 100, overrides: { productivityRate: 2 },
    lines: [{ group: 'FABRIC', label: 'Jersey', quantity: 100, unit: 'MET', unitPriceUsd: 3 }],
  });

  test('the total is the sections plus C.M', () => {
    const r = computeCosting(withFabric);
    assert.equal(r.groups.fabric.total, 300);
    assert.equal(r.cmCostUsd, 5000);
    assert.equal(r.totalCostUsd, 5300);
  });

  test('changing a C.M input moves the total, and the unit cost with it', () => {
    const r = computeCosting({ ...withFabric, firstDegreeQty: 200 });
    assert.equal(r.cmCostUsd, 10_000);
    assert.equal(r.totalCostUsd, 10_300);
    assert.equal(r.unitActualCostUsd, 10_300 / 1000);
  });

  test('when C.M cannot be worked out the total is still the rest of the costs', () => {
    const r = computeCosting({ ...withFabric, overrides: { productivityRate: 0 } });
    assert.equal(r.cmCostUsd, null);
    assert.equal(r.totalCostUsd, 300, 'fabric alone, not zero and not null');
  });
});

describe('filled in from the production records', () => {
  const recorded = base({ dailyCostUsd: 100, machineCount: 10, lineMachineQty: 12, firstDegreeQty: 100, targetPerDay: 500 });

  test('blank days in line are taken from the days sewing was recorded', () => {
    const r = computeCosting({ ...recorded, sewingDays: 6 });
    assert.equal(r.daysInLineUsed, 6);
    assert.equal(r.daysInLineSource, 'production');
    assert.equal(r.machineDaysUsed, 72, '12 machines × 6 sewing days');
    assert.equal(r.daysInLine, null, 'the typed field itself stays blank');
  });

  test('typed days in line always win over the production records', () => {
    const r = computeCosting({ ...recorded, daysInLine: 11, sewingDays: 6 });
    assert.equal(r.machineDaysUsed, 132);
    assert.equal(r.daysInLineSource, 'typed');
  });

  test('no typed days and no sewing leaves machine-days waiting, and says what to do', () => {
    const r = computeCosting({ ...recorded, sewingDays: 0 });
    assert.equal(r.machineDaysUsed, null);
    assert.match(r.waiting.machineDaysUsed ?? '', /days in line/);
  });

  test('nothing counted at end-line leaves C.M waiting, not $0', () => {
    const r = computeCosting({ ...recorded, daysInLine: 11, firstDegreeQty: null });
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd ?? '', /1st degree/);
    assert.equal(r.totalCostUsd, null, 'and no total of $0 is shown either');
  });
});
