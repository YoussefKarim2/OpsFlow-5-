import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting, type CostingInput, type CostLineInput } from './costing.js';
import { fmtMoney, fmtPct, fmtNumber, NOT_CALCULATED } from './num.js';
import { sanitiseOverrides } from './costing-overrides.js';

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

  test('work days and productivity follow the machine-days actually used', () => {
    // BASE records 12 machines on the line for 11 days, so machine-days is
    // 132 — worked out, not the 130 that used to be typed in.
    const r = computeCosting(BASE);
    assert.equal(r.machineDaysUsed, 132);
    assert.ok(Math.abs((r.workDays ?? 0) - 132 / 38) < 1e-9);
    assert.ok(Math.abs((r.productivityRate ?? 0) - 2084 / (132 / 38)) < 1e-6);
  });

  test('the inputs are echoed back so the sheet can print them', () => {
    const r = computeCosting(BASE);
    assert.equal(r.lineMachineQty, 12);
    assert.equal(r.daysInLine, 11);
    assert.equal(r.machineCount, 38);
    assert.equal(r.machineDaysUsed, 132, '12 line machines × 11 days');
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

  test('C.M is the machine run cost per piece, over the pieces that passed', () => {
    // (machine cost × machine-days) ÷ productivity × 1st degree qty, in EGP,
    // converted once. The formula itself is covered in `cm-cost.test.ts`;
    // this holds that the sheet as a whole still produces it.
    const r = computeCosting(shipped);
    const machineCost = 1867 / 38;
    const used = 12 * 11;
    const productivity = 2084 / (used / 38);
    const expected = ((machineCost * used) / productivity) * 1950 / 48.5;
    assert.ok(Math.abs((r.cmCostUsd ?? 0) - expected) < 1e-9,
      `got ${r.cmCostUsd}, expected ${expected}`);
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

describe('actual costing — typing over a calculated cell', () => {
  const priced: CostingInput = {
    ...BASE,
    shippedQty: 1000,
    lines: [line('FABRIC', 'Rosetta', 1000, 'Met.', 2, 'bom:FABRIC')],
  };

  test('a typed figure wins, and says what it replaced', () => {
    const r = computeCosting({ ...priced, overrides: { fabricCostUsd: 1500 } });
    assert.equal(r.fabricCostUsd, 1500);
    assert.ok(r.overridden.includes('fabricCostUsd'));
    assert.equal(r.calculated.fabricCostUsd, 2000, 'the calculated figure is kept alongside');
  });

  test('an override cascades the way a spreadsheet does', () => {
    const plain = computeCosting(priced);
    const typed = computeCosting({ ...priced, overrides: { fabricCostUsd: 1500 } });
    assert.ok(typed.totalCostUsd! < plain.totalCostUsd!, 'the total follows the section');
    assert.ok(typed.unitActualCostUsd! < plain.unitActualCostUsd!, 'so does the unit cost');
    assert.ok(typed.profitPerUnitUsd! > plain.profitPerUnitUsd!, 'and the profit');
  });

  test('overriding the total stops it following its parts', () => {
    const r = computeCosting({ ...priced, overrides: { totalCostUsd: 5000 } });
    assert.equal(r.totalCostUsd, 5000);
    assert.equal(r.unitActualCostUsd, 5);
    assert.equal(r.fabricCostUsd, 2000, 'the section it came from is untouched');
  });

  test('a quantity can be typed over, and everything counting it follows', () => {
    const r = computeCosting({ ...priced, overrides: { shippedQty: 500 } });
    assert.equal(r.shippedQty, 500);
    assert.equal(r.unitActualCostUsd, r.totalCostUsd! / 500);
    assert.ok(Math.abs((r.diffPct ?? 0) - ((500 / 1972) * 100 - 100)) < 1e-9);
  });

  test('a figure can be supplied where nothing could be calculated', () => {
    // Nothing shipped, so the sheet has no unit cost — but an invoice might.
    const r = computeCosting({ ...BASE, overrides: { unitActualCostUsd: 4 } });
    assert.equal(r.unitActualCostUsd, 4);
    assert.equal(r.calculated.unitActualCostUsd, null);
    assert.equal(r.profitPerUnitUsd, 7.25 - 4);
  });

  test('clearing an override falls straight back to the live figure', () => {
    const typed = computeCosting({ ...priced, overrides: { fabricCostUsd: 1500 } });
    const cleared = computeCosting({ ...priced, overrides: {} });
    assert.equal(cleared.fabricCostUsd, typed.calculated.fabricCostUsd);
    assert.deepEqual(cleared.overridden, []);
  });

  test('the identity cells can be typed over without touching the order', () => {
    const r = computeCosting({
      ...priced, customer: 'Real Client', poNumber: 'PO-1',
      overrides: { customer: 'As invoiced', poNumber: 'PO-1-REV-B' },
    });
    assert.equal(r.identity.customer, 'As invoiced');
    assert.equal(r.calculated.customer, 'Real Client');
    assert.equal(r.identity.poNumber, 'PO-1-REV-B');
  });

  test('an override never produces an unrenderable number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = computeCosting({
        ...priced,
        overrides: sanitiseOverrides({ totalCostUsd: bad, shippedQty: bad }),
      });
      for (const [key, value] of Object.entries(r)) {
        if (typeof value !== 'number') continue;
        assert.ok(Number.isFinite(value), `${key} became ${value}`);
      }
    }
  });
});

describe('actual costing — what may be stored as an override', () => {
  test('unknown cells are dropped rather than kept forever', () => {
    assert.deepEqual(sanitiseOverrides({ notACell: 5, totalCostUsd: 10 }), { totalCostUsd: 10 });
  });

  test('cleared cells are removed, not stored as empty', () => {
    assert.deepEqual(sanitiseOverrides({ totalCostUsd: null, customer: '' }), {});
  });

  test('a number that could never render is refused', () => {
    assert.deepEqual(sanitiseOverrides({ totalCostUsd: Number.NaN }), {});
    assert.deepEqual(sanitiseOverrides({ totalCostUsd: Number.POSITIVE_INFINITY }), {});
    assert.deepEqual(sanitiseOverrides({ totalCostUsd: 'not a number' }), {});
  });

  test('text is only accepted where the cell holds text', () => {
    assert.deepEqual(sanitiseOverrides({ customer: '  Acme  ' }), { customer: 'Acme' });
    assert.deepEqual(sanitiseOverrides({ totalCostUsd: '12.5' }), { totalCostUsd: 12.5 });
  });

  test('nonsense input is an empty set, not a crash', () => {
    for (const junk of [null, undefined, 'string', 42, [], [1, 2]]) {
      assert.deepEqual(sanitiseOverrides(junk), {});
    }
  });
});
