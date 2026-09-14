import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting, type CostingInput } from './costing.js';
import { applyRowEdit, rowCost, type RowState } from './costing-rows.js';

/**
 * The dependency chain, end to end.
 *
 * One figure changes and everything downstream of it follows: the row's cost,
 * its section total, the grand total, the cost per unit, the profit, the
 * margin, and the price that would fix a loss. These tests exist to catch a
 * link being broken — a total that stops following its rows is a costing that
 * quietly lies.
 */
const BASE: CostingInput = {
  orderQty: 1000, cutQty: 1050, shippedQty: 1000,
  dollarRate: 48.5, dailyCostEgp: 1867, machineCount: 38,
  machineDaysUsed: 38, daysInLine: 11, lineMachineQty: 12,
  firstDegreeQty: 990, secondDegreeQty: 10,
  sellPriceUsd: 10, lines: [],
};

const fabric = (quantity: number | null, unitPriceUsd: number | null) => ({
  group: 'FABRIC' as const, label: 'Jersey', quantity, unit: 'MET',
  unitPriceUsd, sourceRef: 'bom:FABRIC',
});

describe('one value in, the whole chain moves', () => {
  test('consumption × price cascades to the margin', () => {
    const at = (q: number) => computeCosting({ ...BASE, lines: [fabric(q, 4)] });

    const two = at(2);
    assert.equal(two.groups.fabric.lines[0]!.cost, 8);
    assert.equal(two.groups.fabric.total, 8);

    const three = at(3);
    assert.equal(three.groups.fabric.lines[0]!.cost, 12, 'the row re-costs');
    assert.equal(three.groups.fabric.total, 12, 'the section total follows');
    assert.ok(three.totalCostUsd! > two.totalCostUsd!, 'the grand total follows');
    assert.ok(three.unitActualCostUsd! > two.unitActualCostUsd!, 'so does the unit cost');
    assert.ok(three.profitPerUnitUsd! < two.profitPerUnitUsd!, 'and the profit falls');
    assert.ok(three.profitPct! < two.profitPct!, 'and the margin with it');
  });

  test('every link is arithmetic, not approximation', () => {
    const r = computeCosting({ ...BASE, lines: [fabric(1.25, 4)] });
    const cm = (38 / 38) * 1867 / 48.5;
    assert.equal(r.groups.fabric.lines[0]!.cost, 5);
    assert.equal(r.groups.fabric.total, 5);
    assert.ok(Math.abs(r.cmCostUsd! - cm) < 1e-9);
    assert.ok(Math.abs(r.totalCostUsd! - (5 + cm)) < 1e-9);
    assert.ok(Math.abs(r.unitActualCostUsd! - (5 + cm) / 1000) < 1e-9);
    assert.ok(Math.abs(r.profitPerUnitUsd! - (10 - (5 + cm) / 1000)) < 1e-9);
    assert.ok(Math.abs(r.profitPct! - (r.profitPerUnitUsd! / 10) * 100) < 1e-9);
  });

  test('a second material joins its own section and the total', () => {
    const one = computeCosting({ ...BASE, lines: [fabric(10, 2)] });
    const two = computeCosting({
      ...BASE,
      lines: [
        fabric(10, 2),
        { group: 'ACCESSORY', label: 'Poly bag', quantity: 1000, unit: 'PCS', unitPriceUsd: 0.01, sourceRef: 'bom:POLY_BAG' },
      ],
    });
    assert.equal(two.groups.fabric.total, 20, 'fabric is unchanged by an accessory');
    assert.equal(two.groups.accessory.total, 10);
    assert.ok(Math.abs(two.totalCostUsd! - (one.totalCostUsd! + 10)) < 1e-9);
  });

  test('the sell price moves profit and the margin, and nothing else', () => {
    // 100 × $5 over 1,000 pieces is barely half a dollar each, so "cheap" has
    // to be genuinely below that to be a loss.
    const cheap = computeCosting({ ...BASE, sellPriceUsd: 0.1, lines: [fabric(100, 5)] });
    const dear = computeCosting({ ...BASE, sellPriceUsd: 20, lines: [fabric(100, 5)] });
    assert.equal(cheap.totalCostUsd, dear.totalCostUsd, 'cost does not depend on price');
    assert.equal(cheap.unitActualCostUsd, dear.unitActualCostUsd);
    assert.ok(cheap.profitPerUnitUsd! < dear.profitPerUnitUsd!);
    assert.equal(cheap.isProfitable, false);
    assert.equal(dear.isProfitable, true);
  });

  test('a loss produces the price that would fix it, and profit withdraws it', () => {
    const loss = computeCosting({ ...BASE, sellPriceUsd: 0.1, lines: [fabric(100, 5)] });
    assert.ok(Math.abs(loss.targetPriceUsd! - loss.unitActualCostUsd! * 1.2) < 1e-9);
    const fixed = computeCosting({ ...BASE, sellPriceUsd: loss.targetPriceUsd!, lines: [fabric(100, 5)] });
    assert.equal(fixed.isProfitable, true);
    assert.equal(fixed.targetPriceUsd, null, 'nothing left to fix');
    assert.ok(Math.abs(fixed.profitPct! - 100 / 6) < 1e-6, 'a 20% mark-up is a 16.7% margin');
  });

  test('the machine figures drive work days, productivity and C.M together', () => {
    const slow = computeCosting({ ...BASE, machineDaysUsed: 76 });
    const fast = computeCosting({ ...BASE, machineDaysUsed: 38 });
    assert.ok(slow.workDays! > fast.workDays!);
    assert.ok(slow.productivityRate! < fast.productivityRate!, 'the same cut over more days');
    assert.ok(slow.cmCostUsd! > fast.cmCostUsd!, 'and it costs more to make');
    assert.ok(slow.totalCostUsd! > fast.totalCostUsd!);
  });

  test('shipping short moves the unit cost, the profit and the difference', () => {
    const full = computeCosting({ ...BASE, shippedQty: 1000, lines: [fabric(100, 5)] });
    const short = computeCosting({ ...BASE, shippedQty: 900, lines: [fabric(100, 5)] });
    assert.equal(full.diffPct, 0);
    assert.ok(Math.abs(short.diffPct! + 10) < 1e-9);
    assert.ok(short.unitActualCostUsd! > full.unitActualCostUsd!, 'the same cost over fewer pieces');
    assert.ok(short.profitPerUnitUsd! < full.profitPerUnitUsd!);
  });

  test('a row edited through its cost still cascades', () => {
    // The person has an invoice total, not a rate. The chain must not care.
    let row: RowState = { quantity: null, unitPriceUsd: null, derivedField: null };
    row = applyRowEdit(row, 'quantity', 250);
    row = applyRowEdit(row, 'cost', 1000);
    assert.equal(row.unitPriceUsd, 4);

    const r = computeCosting({
      ...BASE,
      lines: [fabric(row.quantity, row.unitPriceUsd)],
    });
    assert.equal(rowCost(row), 1000);
    assert.equal(r.groups.fabric.total, 1000);
    assert.ok(r.totalCostUsd! > 1000);
  });

  test('repeated edits settle on the same answer as one edit', () => {
    const once = computeCosting({ ...BASE, lines: [fabric(7, 3)] });
    let row: RowState = { quantity: null, unitPriceUsd: null, derivedField: null };
    for (const q of [1, 99, 4, 7]) row = applyRowEdit(row, 'quantity', q);
    for (const p of [10, 0.5, 3]) row = applyRowEdit(row, 'unitPrice', p);
    const after = computeCosting({ ...BASE, lines: [fabric(row.quantity, row.unitPriceUsd)] });
    assert.equal(after.totalCostUsd, once.totalCostUsd);
  });
});

describe('what a missing figure says instead of an error code', () => {
  test('each unknown names the fact it is waiting for', () => {
    const r = computeCosting({
      ...BASE, shippedQty: null, dailyCostEgp: null, machineCount: null,
      dollarRate: null, sellPriceUsd: null, lines: [],
    });
    assert.match(r.waiting.unitActualCostUsd!, /Waiting for/);
    assert.match(r.waiting.machineCostEgpPerDay!, /daily cost|machine count/);
    assert.match(r.waiting.workDays!, /machine/);
    assert.match(r.waiting.profitPerUnitUsd!, /sell price/);
    assert.match(r.waiting.diffPct!, /shipped/);
    assert.match(r.waiting.totalCostUsd!, /cost row/);
  });

  test('a figure that computed is never described as waiting', () => {
    const r = computeCosting({ ...BASE, lines: [fabric(10, 2)] });
    for (const key of ['totalCostUsd', 'unitActualCostUsd', 'profitPerUnitUsd', 'profitPct', 'diffPct', 'workDays']) {
      assert.equal(r.waiting[key], undefined, `${key} computed but claims to be waiting`);
    }
  });

  test('the unit cost distinguishes no costs from no shipment', () => {
    // Nothing costed at all — no materials and no machine figures, so there is
    // no C.M either.
    const noCosts = computeCosting({
      ...BASE, lines: [], dailyCostEgp: null, machineCount: null, machineDaysUsed: null,
    });
    assert.equal(noCosts.totalCostUsd, null);
    assert.match(noCosts.waiting.unitActualCostUsd!, /costs below/);

    const noShipment = computeCosting({ ...BASE, shippedQty: null, lines: [fabric(10, 2)] });
    assert.match(noShipment.waiting.unitActualCostUsd!, /shipped quantity/);
  });

  test('no message ever contains an error code', () => {
    const r = computeCosting({
      ...BASE, orderQty: 0, cutQty: 0, shippedQty: 0, dollarRate: 0,
      dailyCostEgp: 0, machineCount: 0, machineDaysUsed: 0, sellPriceUsd: 0, lines: [],
    });
    for (const text of Object.values(r.waiting)) {
      assert.doesNotMatch(text!, /NaN|Infinity|#DIV|#VALUE|undefined|null/);
    }
  });
});
