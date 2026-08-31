/**
 * Calculation engine tests, asserted against the real values in
 * `PO No. 85 – A302059B Florida T Shirt Summer order 2026.xlsx`.
 *
 * These are not synthetic fixtures. Every expected number below was read out of
 * the workbook. If a refactor breaks one of them, the app has stopped agreeing
 * with the factory's own arithmetic.
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { QtyLedger } from '../enums.js';
import { safeDiv, safePct, roundUp, fmtNumber, fmtMoney, NOT_CALCULATED } from './num.js';
import {
  buildMatrix, computeCutQty, computeCutMatrix, ledgerTotal, computeStockDeduction,
  computeCutVariance, computeFunnel, computeColorProgress, type QtyCell, type AxisRef,
} from './quantities.js';
import { computeProductionAnalytics } from './production.js';
import { computeBomSummary } from './materials.js';
import { computeCosting } from './costing.js';
import { parseSizeRatio, computeLay, computeMarkerPlan, type LayInput } from './materials.js';
import { computeAudit, lookupAql } from './quality.js';
import { ProductionOperation } from '../enums.js';
import { WORKFLOW_TEMPLATE, TEMPLATE_TOTAL_MINUTES } from '../workflow-template.js';

// ── Fixtures from the workbook ──────────────────────────────────────────────

const SIZES: AxisRef[] = ['2YXS', 'YXS', 'YS', 'YM', 'YL', 'S', 'M', 'L', 'XL', '2XL']
  .map((name, i) => ({ id: name, name, position: i }));

const COLORS: AxisRef[] = ['SKY BLUE', 'ATH. GOLD', 'SCARLET', 'LIME']
  .map((name, i) => ({ id: name, name, position: i }));

/** Main Order_Factory.Manger!C23:M26 */
const ORDER_MATRIX: Record<string, number[]> = {
  'SKY BLUE':  [20, 50, 138, 141, 90, 70, 35, 20, 10, 5],
  'ATH. GOLD': [20, 55, 114, 115, 60, 30, 35, 20, 10, 5],
  'SCARLET':   [20, 40,  80,  80, 70, 30, 35, 15, 10, 5],
  'LIME':      [20, 50, 138, 141, 80, 50, 35, 15, 10, 5],
};

function orderCells(): QtyCell[] {
  const out: QtyCell[] = [];
  for (const [color, row] of Object.entries(ORDER_MATRIX)) {
    row.forEach((qty, i) => out.push({ colorId: color, sizeId: SIZES[i]!.id, ledger: QtyLedger.ORDER, qty }));
  }
  return out;
}

const CUT_PCT = 0.05; // Order Details_Coordinator!D18

// ── num.ts ──────────────────────────────────────────────────────────────────

describe('num — the #DIV/0! guarantee', () => {
  test('safeDiv returns null instead of Infinity or NaN', () => {
    assert.equal(safeDiv(10, 0), null);
    assert.equal(safeDiv(0, 0), null);
    assert.equal(safeDiv(null, 5), null);
    assert.equal(safeDiv(5, null), null);
    assert.equal(safeDiv(NaN, 1), null);
    assert.equal(safeDiv(10, 4), 2.5);
  });

  test('formatters never emit NaN, Infinity or an Excel error code', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
      const n = fmtNumber(v as number);
      const m = fmtMoney(v as number);
      assert.equal(n, NOT_CALCULATED);
      assert.equal(m, NOT_CALCULATED);
      for (const bad of ['NaN', 'Infinity', '#DIV/0!', '#VALUE!']) {
        assert.ok(!n.includes(bad) && !m.includes(bad), `formatter leaked ${bad}`);
      }
    }
  });

  test('roundUp matches Excel ROUNDUP(x,0)', () => {
    assert.equal(roundUp(94.5), 95);
    assert.equal(roundUp(148.05), 149);
    assert.equal(roundUp(21), 21);
  });
});

// ── Quantity matrix ─────────────────────────────────────────────────────────

describe('quantities — Main Order sheet', () => {
  const cells = orderCells();
  const m = buildMatrix(cells, COLORS, SIZES, QtyLedger.ORDER);

  test('grand total is 1,972 (Main Order!S46)', () => {
    assert.equal(m.grandTotal, 1972);
  });

  test('row totals match the sheet: 579 / 464 / 385 / 544', () => {
    assert.equal(m.rowTotals['SKY BLUE'], 579);
    assert.equal(m.rowTotals['ATH. GOLD'], 464);
    assert.equal(m.rowTotals['SCARLET'], 385);
    assert.equal(m.rowTotals['LIME'], 544);
  });

  test('column totals match Main Order!D46:M46', () => {
    const expected = [80, 195, 470, 477, 300, 180, 140, 70, 40, 20];
    SIZES.forEach((s, i) => assert.equal(m.colTotals[s.id], expected[i], `size ${s.name}`));
  });

  test('row totals sum back to the grand total', () => {
    const sumRows = Object.values(m.rowTotals).reduce((a, b) => a + b, 0);
    const sumCols = Object.values(m.colTotals).reduce((a, b) => a + b, 0);
    assert.equal(sumRows, m.grandTotal);
    assert.equal(sumCols, m.grandTotal);
  });
});

describe('quantities — Cut Order sheet formula', () => {
  test('per-cell ROUNDUP((order − stock) × 1.05) matches the sheet', () => {
    // Cut Order!D21:M21 for SKY BLUE
    const cases: Array<[number, number]> = [
      [20, 21], [50, 53], [138, 145], [141, 149], [90, 95],
      [70, 74], [35, 37], [20, 21], [10, 11], [5, 6],
    ];
    for (const [order, expected] of cases) {
      assert.equal(computeCutQty(order, 0, CUT_PCT), expected, `order ${order}`);
    }
  });

  test('stock is deducted before the allowance is applied', () => {
    // 138 ordered, 38 in stock → 100 net → 105 to cut.
    assert.equal(computeCutQty(138, 38, CUT_PCT), 105);
    // Fully covered by stock → nothing to cut.
    assert.equal(computeCutQty(20, 25, CUT_PCT), 0);
  });

  test('whole cut matrix totals 2,084 (Cut Order!S44)', () => {
    const cut = computeCutMatrix(orderCells(), COLORS, SIZES, CUT_PCT);
    assert.equal(ledgerTotal(cut, QtyLedger.CUT), 2084);
  });

  test('cut row totals match Cut Order!S21:S24 — 612 / 490 / 407 / 575', () => {
    const cut = computeCutMatrix(orderCells(), COLORS, SIZES, CUT_PCT);
    const m = buildMatrix(cut, COLORS, SIZES, QtyLedger.CUT);
    assert.equal(m.rowTotals['SKY BLUE'], 612);
    assert.equal(m.rowTotals['ATH. GOLD'], 490);
    assert.equal(m.rowTotals['SCARLET'], 407);
    assert.equal(m.rowTotals['LIME'], 575);
  });

  test('cut column totals match Cut Order!D44:M44', () => {
    const cut = computeCutMatrix(orderCells(), COLORS, SIZES, CUT_PCT);
    const m = buildMatrix(cut, COLORS, SIZES, QtyLedger.CUT);
    const expected = [84, 206, 494, 503, 316, 191, 148, 74, 44, 24];
    SIZES.forEach((s, i) => assert.equal(m.colTotals[s.id], expected[i], `size ${s.name}`));
  });
});

describe('quantities — stock deduction and variance', () => {
  test('stock deduction reports required production after stock', () => {
    const cells = [
      ...orderCells(),
      { colorId: 'SKY BLUE', sizeId: 'YS', ledger: QtyLedger.STOCK, qty: 38 } as QtyCell,
    ];
    const d = computeStockDeduction(cells, CUT_PCT);
    assert.equal(d.customerOrderQty, 1972);
    assert.equal(d.usableStockQty, 38);
    assert.equal(d.requiredProductionQty, 1934);
  });

  test('cut variance reports +14 when 2,098 are actually cut against a 2,084 plan', () => {
    const v = computeCutVariance(orderCells(), CUT_PCT, 2098);
    assert.equal(v.plannedCutQty, 2071); // ROUNDUP(1972 × 1.05) at order level
    assert.equal(v.actualCutQty, 2098);
    assert.equal(v.variance, 27);
  });

  test('funnel percentages are null-safe on an untouched order', () => {
    const f = computeFunnel(orderCells());
    assert.equal(f[0]!.qty, 1972);
    assert.equal(f[1]!.qty, 0);
    for (const step of f) {
      assert.ok(step.pctOfOrder === null || Number.isFinite(step.pctOfOrder));
      assert.ok(step.pctOfPrev === null || Number.isFinite(step.pctOfPrev));
    }
  });

  test('per-colour progress is computed independently', () => {
    const cells: QtyCell[] = [
      ...orderCells(),
      { colorId: 'LIME', sizeId: 'YS', ledger: QtyLedger.IN_LINE, qty: 100 },
    ];
    const cp = computeColorProgress(cells, COLORS);
    const lime = cp.find((c) => c.colorId === 'LIME')!;
    assert.equal(lime.ordered, 544);
    assert.equal(lime.produced, 100);
    assert.equal(cp.find((c) => c.colorId === 'SCARLET')!.produced, 0);
  });
});

// ── Production ──────────────────────────────────────────────────────────────

describe('production — rate, projection and delay detection', () => {
  const entries = [
    { date: '2026-08-20', operation: ProductionOperation.SEWING, qty: 450 },
    { date: '2026-08-21', operation: ProductionOperation.SEWING, qty: 520 },
    { date: '2026-08-22', operation: ProductionOperation.SEWING, qty: 610 },
  ];

  test('rate is the mean over active days, and remaining is order − produced', () => {
    const a = computeProductionAnalytics({
      entries, orderQty: 1972, cutQty: 2084,
      requiredDate: '2026-09-13', today: new Date('2026-08-24'),
    });
    assert.equal(a.producedQty, 1580);
    assert.equal(a.remainingQty, 392);
    assert.equal(a.dailyRate, (450 + 520 + 610) / 3);
    assert.equal(a.peakDailyRate, 610);
    assert.equal(a.daysToComplete, 1); // ceil(392 / 526.67)
  });

  test('an order that projects past its required date is flagged behind schedule', () => {
    const slow = [{ date: '2026-08-23', operation: ProductionOperation.SEWING, qty: 10 }];
    const a = computeProductionAnalytics({
      entries: slow, orderQty: 1972, cutQty: 2084,
      requiredDate: '2026-09-13', today: new Date('2026-08-24'),
    });
    assert.equal(a.isBehindSchedule, true);
    assert.ok((a.slipDays ?? 0) > 0);
  });

  test('a comfortable rate is not flagged', () => {
    const a = computeProductionAnalytics({
      entries, orderQty: 1972, cutQty: 2084,
      requiredDate: '2026-09-13', today: new Date('2026-08-24'),
    });
    assert.equal(a.isBehindSchedule, false);
  });

  test('no production data yields nulls, not NaN', () => {
    const a = computeProductionAnalytics({
      entries: [], orderQty: 1972, cutQty: 2084,
      requiredDate: '2026-09-13', today: new Date('2026-08-24'),
    });
    assert.equal(a.dailyRate, null);
    assert.equal(a.projectedCompletion, null);
    assert.equal(a.producedQty, 0);
    assert.equal(a.isBehindSchedule, false);
  });

  test('cutting entries do not inflate the sewing throughput', () => {
    const mixed = [...entries, { date: '2026-08-19', operation: ProductionOperation.CUTTING, qty: 2084 }];
    const a = computeProductionAnalytics({
      entries: mixed, orderQty: 1972, cutQty: 2084, today: new Date('2026-08-24'),
    });
    assert.equal(a.producedQty, 1580);
  });
});

// ── BOM ─────────────────────────────────────────────────────────────────────

describe('materials — BOM shortage matches Bill Of Matrial!L = K − I', () => {
  test("the brief's poly-bag example: 2,084 required, 2,000 issued, 84 short", () => {
    const s = computeBomSummary([
      { id: '1', category: 'POLY_BAG', item: 'Hummel', unit: 'Pcs', requiredQty: 2084, issuedQty: 2000 },
    ]);
    const item = s.items[0]!;
    assert.equal(item.shortage, -84);
    assert.equal(item.shortQty, 84);
    assert.equal(item.status, 'PARTIAL');
    assert.equal(s.fullyIssued, false);
  });

  test('nothing issued reads as NOT_ISSUED, and the order is not ready for production', () => {
    const s = computeBomSummary([
      { id: '1', category: 'FABRIC', item: 'Rosetta', unit: 'Met.', requiredQty: 1194, issuedQty: 0 },
      { id: '2', category: 'POLY_BAG', item: 'Hummel', unit: 'Pcs', requiredQty: 2084, issuedQty: 0 },
    ]);
    assert.equal(s.shortItems, 2);
    assert.equal(s.notIssuedItems, 2);
    assert.equal(s.fullyIssued, false);
    assert.equal(s.overallCoveragePct, 0);
  });

  test('full issue clears the gate', () => {
    const s = computeBomSummary([
      { id: '1', category: 'CARTON', item: 'Protime', unit: 'Pcs', requiredQty: 25, issuedQty: 25 },
    ]);
    assert.equal(s.fullyIssued, true);
    assert.equal(s.overallCoveragePct, 100);
  });
});

// ── Markers ─────────────────────────────────────────────────────────────────

describe('materials — marker plan reproduces the Laying sheet', () => {
  test('size-ratio parser handles sizes that start with digits', () => {
    assert.deepEqual(parseSizeRatio('(YXS1), (YS1), (YM1), (YL1), (M1)'), { YXS: 1, YS: 1, YM: 1, YL: 1, M: 1 });
    assert.deepEqual(parseSizeRatio('(2YXS1), (S3), (L1), (XL1)'), { '2YXS': 1, S: 3, L: 1, XL: 1 });
    assert.deepEqual(parseSizeRatio('(2YXS1), (2XL2)'), { '2YXS': 1, '2XL': 2 });
  });

  test('lay 1 yields 700 pieces over 140 layers — Laying!V15', () => {
    const lay = computeLay({
      id: '1', fabric: 'Rosetta', color: 'White', panel: 'ALL',
      ratio: '(YXS1), (YS1), (YM1), (YL1), (M1)', layers: 140, markerLengthM: 2.61,
      totalLengthM: 391,
    });
    assert.equal(lay.totalPieces, 700);
    // The sheet records 391 m for this lay, not 140 × 2.61 = 365.4. The
    // difference is the end loss and splice allowance, and it is why the
    // recorded figure is stored rather than derived.
    assert.equal(lay.totalLengthM, 391);
    assert.equal(Math.round(lay.theoreticalLengthM), 365);
    assert.ok((lay.allowancePct ?? 0) > 6 && (lay.allowancePct ?? 0) < 8);
  });

  test('a lay with no recorded length falls back to layers x marker', () => {
    const lay = computeLay({
      id: '1', fabric: 'Rosetta', color: 'White', panel: 'ALL',
      ratio: '(YS2), (YM2), (YL1)', layers: 100, markerLengthM: 2.5,
    });
    assert.equal(lay.totalLengthM, 250);
    assert.equal(lay.allowancePct, 0);
  });

  test('the six-lay plan produces 2,090 pieces against a 2,084 requirement (−6)', () => {
    const lays: LayInput[] = [
      { id: '1', fabric: 'Rosetta', color: 'White', panel: 'ALL', ratio: '(YXS1), (YS1), (YM1), (YL1), (M1)', layers: 140, markerLengthM: 2.61, totalLengthM: 391 },
      { id: '2', fabric: 'Rosetta', color: 'White', panel: 'ALL', ratio: '(YS2), (YM2), (YL1)',               layers: 177, markerLengthM: 2.41, totalLengthM: 457 },
      { id: '3', fabric: 'Rosetta', color: 'White', panel: 'ALL', ratio: '(2YXS1), (S3), (L1), (XL1)',        layers: 44,  markerLengthM: 4.15, totalLengthM: 196 },
      { id: '4', fabric: 'Rosetta', color: 'White', panel: 'ALL', ratio: '(2YXS1), (YXS2), (S2), (L1)',       layers: 30,  markerLengthM: 3.20, totalLengthM: 103 },
      { id: '5', fabric: 'Rosetta', color: 'White', panel: 'ALL', ratio: '(2YXS1), (2XL2)',                   layers: 12,  markerLengthM: 2.40, totalLengthM: 31 },
      { id: '6', fabric: 'Rosetta', color: 'White', panel: 'ALL', ratio: '(YXS1), (YM2), (M2)',               layers: 5,   markerLengthM: 2.90, totalLengthM: 16 },
    ];
    const required = { '2YXS': 84, YXS: 206, YS: 494, YM: 503, YL: 316, S: 191, M: 148, L: 74, XL: 44, '2XL': 24 };
    const plan = computeMarkerPlan(lays, required);

    assert.equal(plan.plannedTotal, 2090);   // Laying!V38
    assert.equal(plan.requiredTotal, 2084);  // Laying!AU39
    assert.equal(plan.varianceTotal, 6);
    assert.equal(plan.totalLayers, 408);     // Laying!W38
    // Laying!X38 — the fabric the plan actually consumes.
    assert.equal(plan.totalFabricM, 1194);
    // layers x marker alone comes to 1,113.87 m: 80 m short of the truth.
    assert.equal(Math.round(plan.theoreticalFabricM), 1114);
    assert.ok(Math.abs(plan.allowanceM - 80.13) < 0.01);
    assert.ok((plan.allowancePct ?? 0) > 7 && (plan.allowancePct ?? 0) < 7.5);
    // Per-size drift, Laying!G39:P39 (sheet sign is required − planned).
    assert.equal(plan.varianceBySize['2YXS'], 2);
    assert.equal(plan.varianceBySize['YXS'], -1);
    assert.equal(plan.varianceBySize['YS'], 0);
    assert.equal(plan.varianceBySize['L'], 0);
  });
});

// ── Costing ─────────────────────────────────────────────────────────────────

describe('costing — the #DIV/0! cells become "Not calculated"', () => {
  const base = {
    orderQty: 1972, cutQty: 2084, dollarRate: 48.5,
    dailyCostEgp: 1867, machineCount: 38, machineDaysUsed: 130, daysInLine: 11,
    sellPriceUsd: 7.25, lines: [],
  };

  test('machine economics match Actual Costing!D16/D17/D18', () => {
    const r = computeCosting({ ...base, shippedQty: null });
    assert.ok(Math.abs((r.machineCostEgpPerDay ?? 0) - 49.1315789) < 1e-5);
    assert.ok(Math.abs((r.workDays ?? 0) - 3.4210526) < 1e-6);
    assert.ok(Math.abs((r.productivityRate ?? 0) - 609.1692308) < 1e-4);
  });

  test('unshipped order returns null unit cost rather than #DIV/0!', () => {
    const r = computeCosting({ ...base, shippedQty: null });
    assert.equal(r.unitActualCostUsd, null);
    assert.equal(r.profitPerUnitUsd, null);
    assert.equal(r.profitPct, null);
    assert.equal(fmtMoney(r.unitActualCostUsd), NOT_CALCULATED);
  });

  test('zero shipped quantity also returns null, not Infinity', () => {
    const r = computeCosting({ ...base, shippedQty: 0 });
    assert.equal(r.unitActualCostUsd, null);
  });

  test('CM cost is work days × daily cost, converted at the dollar rate', () => {
    const r = computeCosting({ ...base, shippedQty: 1972 });
    // 3.42105 × 1867 = 6387.11 EGP → / 48.5 = 131.69 USD
    assert.ok(Math.abs((r.cmCostUsd ?? 0) - 131.6929) < 0.01);
  });

  test('a shipped order produces a real unit cost and profit', () => {
    const r = computeCosting({
      ...base, shippedQty: 1950,
      lines: [
        { group: 'FABRIC', label: 'Rosetta', quantity: 1194, unit: 'met.', unitPriceUsd: 2.10 },
        { group: 'ACCESSORY', label: 'Poly Bag', quantity: 2084, unit: 'Pcs', unitPriceUsd: 0.25 / 48.5 },
      ],
    });
    assert.ok(r.unitActualCostUsd !== null && r.unitActualCostUsd > 0);
    assert.ok(r.profitPerUnitUsd !== null);
    assert.equal(r.isProfitable, r.profitPerUnitUsd! > 0);
  });

  test('an unpriced group reports null, not a misleading zero', () => {
    const r = computeCosting({
      ...base, shippedQty: 1950,
      lines: [{ group: 'FABRIC', label: 'Rosetta', quantity: null, unit: 'met.', unitPriceUsd: null }],
    });
    assert.equal(r.fabricCostUsd, null);
  });

  test('target price appears only when the order is loss-making', () => {
    const loss = computeCosting({
      ...base, shippedQty: 10, sellPriceUsd: 1,
      lines: [{ group: 'FABRIC', label: 'F', quantity: 100, unit: 'm', unitPriceUsd: 5 }],
    });
    assert.equal(loss.isProfitable, false);
    assert.ok((loss.targetPriceUsd ?? 0) > 0);
  });
});

// ── Quality ─────────────────────────────────────────────────────────────────

describe('quality — AQL table from Audit!C11:L16', () => {
  test('band lookup matches the printed table', () => {
    assert.equal(lookupAql(20)?.sampleSize, 5);
    assert.equal(lookupAql(300)?.sampleSize, 50);
    assert.equal(lookupAql(2084)?.sampleSize, 125);
    assert.equal(lookupAql(2084)?.rejectCount, 8);
    assert.equal(lookupAql(50000)?.sampleSize, 315);
    assert.equal(lookupAql(5), null);
  });

  test('defects below the reject count pass', () => {
    const a = computeAudit({
      availableQty: 2084,
      defects: [{ category: 'TRIMMING', qty: 3 }, { category: 'CLEANLINESS', qty: 2 }],
    });
    assert.equal(a.sampleSize, 125);
    assert.equal(a.totalDefects, 5);
    assert.equal(a.result, 'PASS');
    assert.equal(a.correctiveActionRequired, false);
  });

  test('defects at the reject count fail and demand a corrective action', () => {
    const a = computeAudit({
      availableQty: 2084,
      defects: [{ category: 'CONSTRUCTION_STITCHING', qty: 8 }],
    });
    assert.equal(a.result, 'FAIL');
    assert.equal(a.correctiveActionRequired, true);
    assert.equal(a.worstCategory, 'CONSTRUCTION_STITCHING');
  });

  test('a manual override is recorded as an override', () => {
    const a = computeAudit({ availableQty: 2084, defects: [{ category: 'PACKING', qty: 8 }], manualResult: 'PASS' });
    assert.equal(a.computedResult, 'FAIL');
    assert.equal(a.result, 'PASS');
    assert.equal(a.overridden, true);
  });
});

// ── Workflow template ───────────────────────────────────────────────────────

describe('workflow template — Progress Status!C8:I34', () => {
  test('all 27 rows are present', () => {
    assert.equal(WORKFLOW_TEMPLATE.length, 27);
  });

  test('total planned effort is 442 minutes', () => {
    assert.equal(TEMPLATE_TOTAL_MINUTES, 442);
  });

  test('every task keeps its Arabic requirement text', () => {
    for (const t of WORKFLOW_TEMPLATE) {
      assert.ok(t.requirementAr.length > 0, `${t.key} lost its Arabic requirement`);
      assert.ok(t.requirementEn.length > 0, `${t.key} has no English requirement`);
    }
  });

  test('task keys are unique', () => {
    assert.equal(new Set(WORKFLOW_TEMPLATE.map((t) => t.key)).size, 27);
  });

  test('sequences run 1..14 with no gaps', () => {
    const seqs = [...new Set(WORKFLOW_TEMPLATE.map((t) => t.sequence))].sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });
});
