import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summariseCostingOverview, costingHeadlineReason, type CostingOverviewRow } from './costing-overview.js';

const row = (over: Partial<CostingOverviewRow>): CostingOverviewRow => ({
  orderId: 'o', poNumber: 'PO', orderName: 'n', clientName: 'c', status: 'IN_PRODUCTION', orderQty: 100, shippedQty: null,
  hasRecord: false, costingDate: null, sellPriceUsd: null, fabricCostUsd: null, accessoryCostUsd: null,
  externalCostUsd: null, cmCostUsd: null, otherCostUsd: null, totalCostUsd: null, unitActualCostUsd: null,
  profitPerUnitUsd: null, profitPct: null, totalProfitUsd: null, isProfitable: null, waitingFor: null, ...over,
});

describe('costing overview totals', () => {
  test('an order still waiting contributes nothing and is counted as waiting, not as zero', () => {
    const s = summariseCostingOverview([
      row({ profitPerUnitUsd: 1, profitPct: 20, totalProfitUsd: 100, totalCostUsd: 400, sellPriceUsd: 5, shippedQty: 100, isProfitable: true }),
      row({ waitingFor: 'Waiting for the sell price' }),
    ]);
    assert.equal(s.orders, 2);
    assert.equal(s.costed, 1);
    assert.equal(s.waiting, 1);
    assert.equal(s.totalProfitUsd, 100);
    assert.equal(s.totalCostUsd, 400);
  });

  test('the margin is revenue-weighted, so a big order weighs more than a small one', () => {
    const s = summariseCostingOverview([
      row({ profitPerUnitUsd: 1, profitPct: 20, totalProfitUsd: 1000, sellPriceUsd: 5, shippedQty: 1000, isProfitable: true }),
      row({ profitPerUnitUsd: -1, profitPct: -50, totalProfitUsd: -10, sellPriceUsd: 2, shippedQty: 10, isProfitable: false }),
    ]);
    assert.equal(Math.round(s.marginPct! * 100) / 100, Math.round((990 / 5020) * 10000) / 100);
    assert.equal(s.avgProfitPct, -15, 'the plain mean, shown for contrast');
    assert.equal(s.profitable, 1);
    assert.equal(s.losing, 1);
  });

  test('nothing costed gives nulls, never NaN', () => {
    const s = summariseCostingOverview([row({}), row({})]);
    assert.equal(s.costed, 0);
    assert.equal(s.totalProfitUsd, null);
    assert.equal(s.marginPct, null);
    assert.equal(s.avgProfitPct, null);
    assert.equal(JSON.stringify(s).includes('NaN'), false);
  });

  test('the headline reason is the first thing a person would fix', () => {
    assert.equal(costingHeadlineReason({ sellPriceUsd: 'Waiting for a price', shippedQty: 'Waiting for a shipment' }), 'Waiting for a price');
    assert.equal(costingHeadlineReason({ shippedQty: 'Waiting for a shipment', totalCostUsd: 'Waiting for a priced cost row' }), 'Waiting for a shipment');
    assert.equal(costingHeadlineReason({}), null);
  });
});
