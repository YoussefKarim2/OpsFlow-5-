import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting, type CostingInput } from './costing.js';

/**
 * The formulas, as the workbook actually writes them.
 *
 * Recovered from `Actual Costing_Coordinator` in the master template — the copy
 * carried inside the PO 89-39 import, which is the only one in the repository.
 * Each case names the cell it came from, so a future change to this arithmetic
 * has to argue with the source rather than with somebody's memory of it.
 *
 *   D16  Machine Cost      =D13/D14            daily cost ÷ all factory machines
 *   D17  Work Days         =D22/D14            machine-days used ÷ all machines
 *   D18  Productivity rate =J12/D17            cut qty ÷ work days
 *   N11  Diff. Percentage  =(L11/J11)-100%     shipped ÷ ordered − 100%
 *   N14  row Cost          =K14*M14            consumption × unit price
 *   O14  row Percentage    =N14/$N$37          cost ÷ total
 *   N18  Fabric Costing    =SUM(N14:N15)
 *   N33  Accesory Costing  =SUM(N19:N32)
 *   N36  C.M               =D17*D13            work days × daily cost
 *   N37  Total             =SUM(N18,N33:N36)
 *   D24  Unit Actual Cost  =N37/L11            total ÷ SHIPPED qty
 *   D26  Profit            =D25-D24            sell price − unit cost
 *   D27  Pro. Percentage   =D26/D25            profit ÷ sell price
 *   D28  Perfect price     =IF(D26<=0,D24*1.2,"Perfect")
 *
 * The workbook's own live values are used where it has them, so these are
 * checked against numbers Excel itself produced.
 */
const SHEET = {
  dailyCostEgp: 1867,     // D13
  machineCount: 38,       // D14
  machineDaysUsed: 130,   // D22
  dollarRate: 48.5,       // D12
};

const BASE: CostingInput = {
  orderQty: 1972, cutQty: 2084, shippedQty: 1950,
  ...SHEET, daysInLine: 11, sellPriceUsd: 7.25, lines: [],
};

describe('the workbook formulas, cell by cell', () => {
  test('D16 — Machine Cost is the daily cost over all factory machines', () => {
    const r = computeCosting(BASE);
    // Excel's own value in D16.
    assert.ok(Math.abs(r.machineCostEgpPerDay! - 49.131578947368418) < 1e-12);
  });

  test('D17 — Work Days is machine-days used over all factory machines', () => {
    const r = computeCosting(BASE);
    // Excel's own value in D17. This is the formula that was in question:
    // =D22/D14, where D21 labels D22 "Machine Already Used".
    assert.ok(Math.abs(r.workDays! - 3.4210526315789473) < 1e-12);
    assert.ok(Math.abs(r.workDays! - 130 / 38) < 1e-12);
  });

  test('D18 — Productivity rate is the cut quantity over the work days', () => {
    const r = computeCosting({ ...BASE, cutQty: 69 });
    // Excel's own value in D18, with its own J12 of 69.
    assert.ok(Math.abs(r.productivityRate! - 20.169230769230769) < 1e-12);
  });

  test('N11 — Diff. Percentage is shipped over ordered, less 100%', () => {
    const r = computeCosting({ ...BASE, orderQty: 1000, shippedQty: 900 });
    assert.ok(Math.abs(r.diffPct! - (-10)) < 1e-12);
  });

  test('N14 and O14 — a row costs consumption × price, and shows its share', () => {
    const r = computeCosting({
      ...BASE,
      lines: [{ group: 'FABRIC', label: 'Fabric 1', quantity: 1194, unit: 'met.', unitPriceUsd: 2.1 }],
    });
    assert.equal(r.groups.fabric.lines[0]!.cost, 1194 * 2.1);
    assert.ok(Math.abs(r.groups.fabric.lines[0]!.pctOfTotal!
      - (1194 * 2.1 / r.totalCostUsd!) * 100) < 1e-9);
  });

  test('N18 and N33 — each section is the sum of its own rows', () => {
    const r = computeCosting({
      ...BASE,
      lines: [
        { group: 'FABRIC', label: 'F1', quantity: 10, unit: 'met.', unitPriceUsd: 2 },
        { group: 'FABRIC', label: 'F2', quantity: 5, unit: 'met.', unitPriceUsd: 3 },
        { group: 'ACCESSORY', label: 'Bag', quantity: 100, unit: 'Pcs', unitPriceUsd: 1 / 48.5 },
      ],
    });
    assert.equal(r.groups.fabric.total, 35);
    assert.ok(Math.abs(r.groups.accessory.total! - 100 / 48.5) < 1e-12);
  });

  test('N36 — C.M is work days × daily cost', () => {
    const r = computeCosting(BASE);
    const egp = (130 / 38) * 1867;
    // The one place OpsFlow deliberately differs: the workbook adds this EGP
    // figure straight into a total whose other rows are already USD. Every
    // unit price on the sheet is quoted `=<egp>/$D$12`, so the total is in
    // dollars and the C.M row is not. OpsFlow converts it at the same rate,
    // which is the only reading under which the Total column is one currency.
    assert.ok(Math.abs(r.cmCostUsd! - egp / 48.5) < 1e-12);
  });

  test('N37 — the Total is the sections plus C.M', () => {
    const r = computeCosting({
      ...BASE,
      lines: [{ group: 'FABRIC', label: 'F', quantity: 10, unit: 'met.', unitPriceUsd: 2 }],
    });
    assert.ok(Math.abs(r.totalCostUsd! - (20 + r.cmCostUsd!)) < 1e-12);
  });

  test('D24 — Unit Actual Cost divides by the SHIPPED quantity', () => {
    // =N37/L11, and L11 is captioned "Shipped Qty" by K11. Not the order
    // quantity, not the cut quantity.
    const r = computeCosting({
      ...BASE, orderQty: 1972, cutQty: 2084, shippedQty: 1950,
      lines: [{ group: 'FABRIC', label: 'F', quantity: 100, unit: 'met.', unitPriceUsd: 10 }],
    });
    assert.ok(Math.abs(r.unitActualCostUsd! - r.totalCostUsd! / 1950) < 1e-12);
    assert.notEqual(r.unitActualCostUsd, r.totalCostUsd! / 1972);
    assert.notEqual(r.unitActualCostUsd, r.totalCostUsd! / 2084);
  });

  test('D26 and D27 — profit is the price less the unit cost, over the price', () => {
    const r = computeCosting({
      ...BASE,
      lines: [{ group: 'FABRIC', label: 'F', quantity: 100, unit: 'met.', unitPriceUsd: 10 }],
    });
    assert.ok(Math.abs(r.profitPerUnitUsd! - (7.25 - r.unitActualCostUsd!)) < 1e-12);
    assert.ok(Math.abs(r.profitPct! - (r.profitPerUnitUsd! / 7.25) * 100) < 1e-12);
  });

  test('D28 — Perfect price is the 20% mark-up, and only when losing money', () => {
    const profit = computeCosting({
      ...BASE, lines: [{ group: 'FABRIC', label: 'F', quantity: 1, unit: 'met.', unitPriceUsd: 1 }],
    });
    assert.equal(profit.targetPriceUsd, null, 'the sheet writes "Perfect" here');

    const loss = computeCosting({
      ...BASE, sellPriceUsd: 0.01,
      lines: [{ group: 'FABRIC', label: 'F', quantity: 100, unit: 'met.', unitPriceUsd: 10 }],
    });
    assert.ok(Math.abs(loss.targetPriceUsd! - loss.unitActualCostUsd! * 1.2) < 1e-12);
  });

  test('a shipped quantity of zero divides by nothing and says why', () => {
    for (const shippedQty of [0, null]) {
      const r = computeCosting({
        ...BASE, shippedQty,
        lines: [{ group: 'FABRIC', label: 'F', quantity: 100, unit: 'met.', unitPriceUsd: 10 }],
      });
      assert.equal(r.unitActualCostUsd, null);
      assert.equal(r.profitPerUnitUsd, null);
      assert.match(r.waiting.unitActualCostUsd!, /shipped quantity/);
    }
  });
});

/**
 * Where OpsFlow knowingly departs from the workbook, and why. Each of these is
 * a decision, not a drift, and is listed so it stays a decision.
 */
describe('deliberate departures from the workbook', () => {
  test('C.M is converted to dollars; the workbook leaves it in pounds', () => {
    const r = computeCosting(BASE);
    const egp = (130 / 38) * 1867;
    assert.ok(r.cmCostUsd! < egp, 'converted, not added raw to a dollar total');
  });

  test('2nd Degree is the recorded count, not cut minus first degree', () => {
    // The workbook computes =J12-L12. OpsFlow reads the second-degree ledger,
    // which is counted on the floor — so pieces merely unaccounted for are not
    // reported as rejects.
    const r = computeCosting({ ...BASE, cutQty: 2084, firstDegreeQty: 1950, secondDegreeQty: 24 });
    assert.equal(r.secondDegreeQty, 24);
    assert.notEqual(r.secondDegreeQty, 2084 - 1950);
  });
});
