import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readLineMachines, linePlanOf, daysAtTarget } from './line-plan.js';

describe('the production line plan', () => {
  test("the sheet's table: blanks kept, total counted", () => {
    const plan = linePlanOf({
      targetPerDay: 500, productionLineName: null,
      lineMachines: [{ type: 'Single', qty: 4 }, { type: 'Over', qty: 8 }, { type: 'Flat Seam', qty: null }, { type: 'Cover Stitch', qty: 1 }],
    });
    assert.equal(plan.totalMachines, 13);
    assert.equal(plan.machines[2]!.qty, null);
  });

  test('malformed stored data is dropped, not thrown on', () => {
    assert.deepEqual(readLineMachines('x'), []);
    assert.deepEqual(readLineMachines([null, { type: '' }, { type: ' Elastic ', qty: -1 }, { type: 'Bar tack', qty: 2.4 }]),
      [{ type: 'Elastic', qty: null }, { type: 'Bar tack', qty: 2 }]);
  });

  test('days at target', () => {
    assert.equal(daysAtTarget(1092, 500), 3);
    assert.equal(daysAtTarget(0, 500), null);
    assert.equal(daysAtTarget(100, null), null);
  });
});
