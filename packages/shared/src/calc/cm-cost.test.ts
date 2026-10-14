import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting, type CostingInput } from './costing.js';
import { fmtMoney, NOT_CALCULATED } from './num.js';

/**
 * Cut-and-make, to the formula the factory uses.
 *
 *   Machine Cost         = Daily Cost ÷ All Factory Machines
 *   Machine Already Used = Line Machines Qty × Days in Line
 *   Work Days            = Machine Already Used ÷ All Factory Machines
 *   Productivity Rate    = Cut Qty ÷ Work Days
 *   C.M Cost             = Daily Cost ÷ Productivity Rate × 1st Degree Qty
 *
 * Daily cost over the pieces a day produces is what one piece costs to make;
 * the pieces that passed inspection are the ones charged for. Multiplied out
 * it is the machine run cost (machine cost × machine-days) spread over the
 * pieces cut, so it can never exceed what the machines cost to run, and when
 * every cut piece passes it is the workbook's own work days × daily cost.
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
  test('daily cost 100, productivity 2, 1st degree 100 → 5,000', () => {
    // Stated directly: every input pinned, so only the final arithmetic is
    // under test. (100 ÷ 2) × 100.
    const r = computeCosting(base({
      dailyCostUsd: 100, machineCount: 10,          // machine cost 10
      firstDegreeQty: 100,
      overrides: { machineDaysUsed: 5, productivityRate: 2 },
    }));
    assert.equal(r.machineCostPerDay, 10);
    assert.equal(r.machineDaysUsed, 5);
    assert.equal(r.productivityRate, 2);
    assert.equal(r.cmCostUsd, 5000);
  });

  test('the whole chain: 100 ÷ 10, 2 × 5, 10 ÷ 10, 1000 ÷ 1, then (100 ÷ 1000) × 100 → 10', () => {
    const r = computeCosting(base({
      dailyCostUsd: 100, machineCount: 10,
      lineMachineQty: 2, daysInLine: 5,
      cutQty: 1000, firstDegreeQty: 100,
    }));
    assert.equal(r.machineCostPerDay, 10, 'Daily Cost ÷ All Factory Machines');
    assert.equal(r.machineDaysUsed, 10, 'Line Machines Qty × Days in Line');
    assert.equal(r.workDays, 1, 'Machine Already Used ÷ All Factory Machines');
    assert.equal(r.productivityRate, 1000, 'Cut Qty ÷ Work Days');
    assert.equal(r.cmCostUsd, 10, 'Daily Cost ÷ Productivity Rate × 1st Degree Qty');
  });

  test('multiplied out, it is the machine run cost spread over the pieces cut', () => {
    // Machine cost 10 × 10 machine-days = $100 to run the machines, over
    // 1,000 pieces cut = 0.1 a piece, charged for the 100 that passed.
    const r = computeCosting(base({
      dailyCostUsd: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5,
      cutQty: 1000, firstDegreeQty: 100,
    }));
    assert.equal(r.cmCostUsd, (10 * 10) / 1000 * 100);
  });

  test('it never exceeds what the machines cost to run', () => {
    // 1,867 a day, 38 machines, 12 on the line for 11 days: the run cost is
    // 49.13 × 132 = $6,486. With every cut piece passing, C.M is exactly
    // that; it cannot be three times it, as it once was.
    const run = (1867 / 38) * 132;
    const all = computeCosting(base({
      dailyCostUsd: 1867, machineCount: 38, lineMachineQty: 12, daysInLine: 11,
      cutQty: 2084, firstDegreeQty: 2084,
    }));
    assert.ok(Math.abs(all.cmCostUsd! - run) < 1e-9, `${all.cmCostUsd} should be ${run}`);
    const some = computeCosting(base({
      dailyCostUsd: 1867, machineCount: 38, lineMachineQty: 12, daysInLine: 11,
      cutQty: 2084, firstDegreeQty: 1950,
    }));
    assert.ok(some.cmCostUsd! < run);
    assert.ok(Math.abs(some.cmCostUsd! - run * 1950 / 2084) < 1e-9);
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
  // Machine cost 10, machine-days 10, work days 1, productivity 1,000 → C.M 10.
  const settled = base({
    dailyCostUsd: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5,
    cutQty: 1000, firstDegreeQty: 100,
  });
  const cm = (over: Partial<CostingInput>) => computeCosting({ ...settled, ...over }).cmCostUsd;

  test('doubling the daily cost doubles it', () => {
    assert.equal(cm({ dailyCostUsd: 200 }), 20);
  });

  test('doubling the factory machines halves it', () => {
    // Half the work days, twice the productivity: each piece cost half.
    assert.equal(cm({ machineCount: 20 }), 5);
  });

  test('doubling the line machines doubles it', () => {
    assert.equal(cm({ lineMachineQty: 4 }), 20);
  });

  test('doubling the days in line doubles it', () => {
    assert.equal(cm({ daysInLine: 10 }), 20);
  });

  test('doubling the cut quantity halves it', () => {
    // The same run made twice the pieces, so each cost half.
    assert.equal(cm({ cutQty: 2000 }), 5);
  });

  test('typing twice the productivity rate halves it', () => {
    assert.equal(cm({ overrides: { productivityRate: 2000 } }), 5);
  });

  test('doubling the 1st degree quantity doubles it', () => {
    assert.equal(cm({ firstDegreeQty: 200 }), 20);
  });

  test('the sell price and the order quantity do not touch it', () => {
    assert.equal(cm({ sellPriceUsd: 99 }), 10);
    assert.equal(cm({ orderQty: 999_999 }), 10);
  });
});

describe('C.M when something it needs is missing', () => {
  const partial = base({
    dailyCostUsd: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5, firstDegreeQty: 100,
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

  test('no daily cost says so', () => {
    const r = computeCosting({ ...partial, dailyCostUsd: null, overrides: { productivityRate: 2 } });
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd!, /daily cost/);
  });

  test('no line or days, and nothing stored, says so', () => {
    const r = computeCosting({ ...partial, lineMachineQty: null, daysInLine: null });
    assert.equal(r.machineDaysUsed, null);
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd!, /line machines and days/);
  });

  test('a typed productivity rate is enough, even with no line or days', () => {
    // The rate is the only thing the machine figures feed into C.M. Somebody
    // who knows it can type it, and the sheet does not hold out for the
    // figures it would have worked it out from.
    const r = computeCosting({
      ...partial, lineMachineQty: null, daysInLine: null, overrides: { productivityRate: 2 },
    });
    assert.equal(r.cmCostUsd, 5000, '(100 ÷ 2) × 100');
  });

  test('nothing can ever render as an error code', () => {
    const hostile: Array<Partial<CostingInput>> = [
      { machineCount: 0 }, { dailyCostUsd: 0 }, { lineMachineQty: 0 }, { daysInLine: 0 },
      { firstDegreeQty: 0 }, { cutQty: 0 },
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
    dailyCostUsd: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5,
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
    const r = computeCosting({ ...withFabric, firstDegreeQty: 200 });   // C.M doubles
    assert.equal(r.cmCostUsd, 10_000);
    assert.equal(r.totalCostUsd, 10_300);
    assert.equal(r.unitActualCostUsd, 10_300 / 1000);
  });

  test('when C.M cannot be worked out the total is still the rest of the costs', () => {
    const r = computeCosting({ ...withFabric, overrides: { productivityRate: 0 } });
    assert.equal(r.cmCostUsd, null);
    assert.equal(r.totalCostUsd, 300, 'fabric alone, not zero and not null');
  });

  test('C.M joins the material costs as it is — one currency, nothing converted', () => {
    const r = computeCosting(withFabric);
    assert.equal(r.cmCostUsd, 5000);
    assert.equal(r.groups.fabric.total, 300);
    assert.equal(r.totalCostUsd, 5300);
  });
});

describe('filled in from the production records', () => {
  test('blank days in line are taken from the days sewing was recorded', () => {
    const r = computeCosting(base({ lineMachineQty: 12, daysInLine: null, sewingDays: 6 }));
    assert.equal(r.daysInLineUsed, 6);
    assert.equal(r.daysInLineSource, 'production');
    assert.equal(r.machineDaysUsed, 72, '12 machines × 6 sewing days');
    assert.equal(r.daysInLine, null, 'the typed field itself stays blank');
  });

  test('typed days in line always win over the production records', () => {
    const r = computeCosting(base({ lineMachineQty: 12, daysInLine: 11, sewingDays: 6 }));
    assert.equal(r.machineDaysUsed, 132);
    assert.equal(r.daysInLineSource, 'typed');
  });

  test('no typed days and no sewing leaves machine-days waiting, and says what to do', () => {
    const r = computeCosting(base({ lineMachineQty: 12, daysInLine: null, sewingDays: 0 }));
    assert.equal(r.machineDaysUsed, null);
    assert.match(r.waiting.machineDaysUsed ?? '', /days in line/);
  });

  test('the sewing days travel in the source, so the sheet in the browser computes the same', () => {
    const r = computeCosting(base({ sewingDays: 4, cutQtySource: 'recorded' }));
    assert.equal(r.source.sewingDays, 4);
    assert.equal(r.source.cutQtySource, 'recorded');
  });

  test('nothing counted at end-line leaves C.M waiting, not $0', () => {
    const r = computeCosting(base({
      dailyCostUsd: 100, machineCount: 10, lineMachineQty: 2, daysInLine: 5, firstDegreeQty: null,
    }));
    assert.equal(r.cmCostUsd, null);
    assert.match(r.waiting.cmCostUsd ?? '', /1st degree/);
    assert.equal(r.totalCostUsd, null, 'and no total of $0 is shown either');
  });
});
