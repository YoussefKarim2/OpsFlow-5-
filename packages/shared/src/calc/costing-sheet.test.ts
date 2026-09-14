import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting, type CostingInput, type CostLineInput } from './costing.js';
import { fmtMoney, fmtPct, fmtNumber, NOT_CALCULATED } from './num.js';

/**
 * The Actual Costing sheet, cell by cell.
 *
 * The figures below are the workbook's own: 1,867 EGP a day across 38
 * machines, 130 machine-days on this order, sold at $7.25. The tests assert
 * the arithmetic the sheet performs, and — just as importantly — that the five
 * cells which read `#DIV/0!` in the live workbook read "Not calculated" here.
 */
const BASE: CostingInput = {
  orderQty: 1972, cutQty: 2084, shippedQty: null,
  dollarRate: 48.5, dailyCostEgp: 1867, machineCount: 38,
  machineDaysUsed: 130, daysInLine: 11, lineMachineQty: 12,
  firstDegreeQty: 1950, secondDegreeQty: 24,
  sellPriceUsd: 7.25, lines: [],
};

const line = (
  group: CostLineInput['group'], label: string,
  quantity: number | null, unit: string, unitPriceUsd: number | null,
  sourceRef?: string,
): CostLineInput => ({ group, label, quantity, unit, unitPriceUsd, sourceRef });

describe('actual costing — the header block', () => {
  test('machine cost is the daily cost spread over the factory', () => {
    const r = computeCosting(BASE);
    assert.ok(Math.abs((r.machineCostEgpPerDay ?? 0) - 1867 / 38) < 1e-9);
  });

  test('work days and productivity follow the sheet', () => {
    const r = computeCosting(BASE);
    assert.ok(Math.abs((r.workDays ?? 0) - 130 / 38) < 1e-9);
    assert.ok(Math.abs((r.productivityRate ?? 0) - 2084 / (130 / 38)) < 1e-6);
  });

  test('the inputs are echoed back so the sheet can print them', () => {
    const r = computeCosting(BASE);
    assert.equal(r.lineMachineQty, 12);
    assert.equal(r.daysInLine, 11);
    assert.equal(r.machineCount, 38);
    assert.equal(r.machineDaysUsed, 130);
    assert.equal(r.dailyCostEgp, 1867);
    assert.equal(r.dollarRate, 48.5);
  });
});

describe('actual costing — production quantities', () => {
  test('first and second degree are counted, never subtracted', () => {
    // The sheet once derived second degree as cut − shipped. OpsFlow counts
    // both on the floor, so a piece that is merely unshipped is not reported
    // as a B-grade reject.
    const r = computeCosting({ ...BASE, shippedQty: 1900 });
    assert.equal(r.firstDegreeQty, 1950);
    assert.equal(r.secondDegreeQty, 24);
    assert.notEqual(r.secondDegreeQty, r.cutQty - 1900);
  });

  test('Diff. Percentage is signed distance from the order, not the share of it', () => {
    // `=(L11/J11)-100%`. Shipping 900 of 1,000 is ten per cent short.
    const short = computeCosting({ ...BASE, orderQty: 1000, shippedQty: 900 });
    assert.ok(Math.abs((short.diffPct ?? 0) + 10) < 1e-9);
    assert.ok(Math.abs((short.shippedVsOrderedPct ?? 0) - 90) < 1e-9);

    const exact = computeCosting({ ...BASE, orderQty: 1000, shippedQty: 1000 });
    assert.equal(exact.diffPct, 0);

    const over = computeCosting({ ...BASE, orderQty: 1000, shippedQty: 1050 });
    assert.ok(Math.abs((over.diffPct ?? 0) - 5) < 1e-9);
  });

  test('nothing shipped leaves the difference uncalculated rather than −100%', () => {
    const r = computeCosting(BASE);
    assert.equal(r.diffPct, null);
    assert.equal(fmtPct(r.diffPct), NOT_CALCULATED);
  });

  test('an order of zero does not divide by it', () => {
    const r = computeCosting({ ...BASE, orderQty: 0, shippedQty: 10 });
    assert.equal(r.diffPct, null);
  });
});

describe('actual costing — the costing table', () => {
  const withMaterials = {
    ...BASE,
    shippedQty: 1950,
    lines: [
      line('FABRIC', 'Rosetta', 1194, 'Met.', 2.1, 'bom:FABRIC'),
      line('FABRIC', 'Mesh', 300, 'Met.', 1.5, 'bom:FABRIC'),
      line('ACCESSORY', 'Poly bag', 2084, 'Pcs', 0.01, 'bom:PACKAGING'),
    ],
  };

  test('materials keep their own consumption, unit and price', () => {
    const r = computeCosting(withMaterials);
    const rosetta = r.groups.fabric.lines.find((l) => l.label === 'Rosetta')!;
    assert.equal(rosetta.quantity, 1194);
    assert.equal(rosetta.unit, 'Met.');
    assert.equal(rosetta.unitPriceUsd, 2.1);
    assert.ok(Math.abs(rosetta.cost! - 1194 * 2.1) < 1e-9);
  });

  test('a section subtotal is the sum of its rows', () => {
    const r = computeCosting(withMaterials);
    assert.ok(Math.abs(r.groups.fabric.total! - (1194 * 2.1 + 300 * 1.5)) < 1e-9);
    assert.ok(Math.abs(r.groups.accessory.total! - 2084 * 0.01) < 1e-9);
    assert.equal(r.groups.fabric.total, r.fabricCostUsd);
  });

  test('percentages are the share of the total and add up', () => {
    const r = computeCosting(withMaterials);
    const shares: Array<number | null> = [
      r.groups.fabric.pctOfTotal,
      r.groups.accessory.pctOfTotal,
      ((r.cmCostUsd ?? 0) / (r.totalCostUsd ?? 1)) * 100,
    ];
    const summed = shares.reduce<number>((a, b) => a + (b ?? 0), 0);
    assert.ok(Math.abs(summed - 100) < 1e-6, `shares summed to ${summed}`);
  });

  test('an unpriced material shows no cost rather than a free one', () => {
    const r = computeCosting({
      ...withMaterials,
      lines: [...withMaterials.lines, line('FABRIC', 'Lining', 40, 'Met.', null, 'bom:FABRIC')],
    });
    const lining = r.groups.fabric.lines.find((l) => l.label === 'Lining')!;
    assert.equal(lining.cost, null);
    assert.notEqual(lining.cost, 0);
    // The rest of the section still totals, so the screen is not blanked by one
    // missing price — and the blank row says which one it is.
    assert.ok((r.groups.fabric.total ?? 0) > 0);
  });

  test('a section with nothing in it reports null, never zero', () => {
    const r = computeCosting({ ...BASE, shippedQty: 100 });
    assert.equal(r.groups.fabric.total, null);
    assert.equal(r.groups.accessory.total, null);
    assert.equal(fmtMoney(r.groups.fabric.total), NOT_CALCULATED);
  });
});

describe('actual costing — outside work is never billed twice', () => {
  const sublimated = [line('EXTERNAL', 'Sublimation', 2000, 'PCS', 0.25, 'external:SUBLIMATION')];

  test('a priced outside operation becomes the sheet row', () => {
    const r = computeCosting({ ...BASE, shippedQty: 1950, lines: sublimated });
    assert.equal(r.sublimationCostUsd, 500);
  });

  test('a figure typed on the costing replaces the derived one, it does not add', () => {
    const r = computeCosting({
      ...BASE, shippedQty: 1950, lines: sublimated, sublimationCostUsd: 420,
    });
    assert.equal(r.sublimationCostUsd, 420);
    // 500 + 420 would be the bug this guards: the same sublimation twice.
    assert.equal(r.externalCostUsd, 420);
  });

  test('embroidery is recognised however the operation was spelled', () => {
    for (const label of ['Embroidery', 'EMBROIDERED BADGE', 'embroidering']) {
      const r = computeCosting({
        ...BASE, shippedQty: 1950,
        lines: [line('EXTERNAL', label, 100, 'PCS', 1, 'external:EMBROIDERY')],
      });
      assert.equal(r.embroideryCostUsd, 100, `${label} should be embroidery`);
    }
  });

  test('outside work that is neither stays its own row and still counts', () => {
    const r = computeCosting({
      ...BASE, shippedQty: 1950,
      lines: [line('EXTERNAL', 'Washing', 500, 'PCS', 0.4, 'external:WASHING')],
    });
    assert.equal(r.sublimationCostUsd, null);
    assert.equal(r.embroideryCostUsd, null);
    assert.equal(r.groups.external.lines.length, 1);
    assert.equal(r.externalCostUsd, 200);
  });
});

describe('actual costing — the money', () => {
  const shipped = {
    ...BASE,
    shippedQty: 1950,
    lines: [line('FABRIC', 'Rosetta', 1000, 'Met.', 2, 'bom:FABRIC')],
  };

  test('C.M is work days × daily cost, converted at the stored rate', () => {
    const r = computeCosting(shipped);
    const expected = (130 / 38) * 1867 / 48.5;
    assert.ok(Math.abs((r.cmCostUsd ?? 0) - expected) < 1e-9);
  });

  test('unit cost divides the total by what shipped', () => {
    const r = computeCosting(shipped);
    assert.ok(Math.abs((r.unitActualCostUsd ?? 0) - r.totalCostUsd! / 1950) < 1e-9);
    assert.ok(Math.abs((r.profitPerUnitUsd ?? 0) - (7.25 - r.unitActualCostUsd!)) < 1e-9);
    assert.ok(Math.abs((r.profitPct ?? 0) - (r.profitPerUnitUsd! / 7.25) * 100) < 1e-9);
  });

  test('"Perfect price" appears only when the order is losing money', () => {
    const profitable = computeCosting(shipped);
    assert.equal(profitable.isProfitable, true);
    assert.equal(profitable.targetPriceUsd, null);   // the sheet prints "Perfect"

    const loss = computeCosting({ ...shipped, sellPriceUsd: 0.5 });
    assert.equal(loss.isProfitable, false);
    assert.ok(Math.abs(loss.targetPriceUsd! - loss.unitActualCostUsd! * 1.2) < 1e-9);
  });

  test('the five #DIV/0! cells read "Not calculated" instead', () => {
    const r = computeCosting(BASE);           // nothing shipped, as in the live sheet
    for (const v of [r.unitActualCostUsd, r.profitPerUnitUsd, r.profitPct, r.diffPct, r.totalProfitUsd]) {
      assert.equal(v, null);
    }
    assert.equal(fmtMoney(r.unitActualCostUsd), NOT_CALCULATED);
    assert.equal(fmtPct(r.profitPct), NOT_CALCULATED);
  });

  test('no cell can ever render NaN, Infinity or an Excel error code', () => {
    const hostile: CostingInput[] = [
      { ...BASE, machineCount: 0, dailyCostEgp: 0, shippedQty: 0, orderQty: 0, cutQty: 0 },
      { ...BASE, dollarRate: 0, shippedQty: 1 },
      { ...BASE, dollarRate: null, dailyCostEgp: null, machineCount: null, machineDaysUsed: null },
      { ...BASE, sellPriceUsd: 0, shippedQty: 5, lines: [line('FABRIC', 'F', 1, 'M', 1)] },
      { ...BASE, orderQty: 0, shippedQty: 0, cutQty: 0, lines: [line('FABRIC', 'F', null, 'M', null)] },
    ];
    for (const input of hostile) {
      const r = computeCosting(input);
      for (const [key, value] of Object.entries(r)) {
        if (typeof value !== 'number') continue;
        assert.ok(Number.isFinite(value), `${key} produced ${value}`);
      }
      for (const text of [
        fmtMoney(r.unitActualCostUsd), fmtPct(r.profitPct), fmtNumber(r.productivityRate),
        fmtMoney(r.totalCostUsd), fmtPct(r.diffPct), fmtMoney(r.cmCostUsd),
      ]) {
        assert.doesNotMatch(text, /NaN|Infinity|#DIV|#VALUE|#REF|undefined|null/);
      }
    }
  });

  test('without a dollar rate nothing is converted at a rate nobody chose', () => {
    const r = computeCosting({ ...BASE, dollarRate: null, shippedQty: 1950 });
    assert.equal(r.cmCostUsd, null);
    assert.equal(r.unitActualCostEgp, null);
  });

  test('a brand-new order costs nothing and claims nothing', () => {
    const r = computeCosting({
      hasRecord: false,
      orderQty: 0, cutQty: 0, shippedQty: null,
      dollarRate: null, dailyCostEgp: null, machineCount: null,
      machineDaysUsed: null, daysInLine: null, sellPriceUsd: null, lines: [],
    });
    assert.equal(r.hasRecord, false);
    assert.equal(r.totalCostUsd, null);
    assert.equal(r.unitActualCostUsd, null);
    assert.equal(r.groups.fabric.lines.length, 0);
  });
});
