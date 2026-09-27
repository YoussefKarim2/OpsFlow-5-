/**
 * Regressions from the end-to-end audit of quantities, alerts and status.
 *
 * Each test names the situation a coordinator saw, because each was reported
 * as "the screen says something the floor knows is false".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { QtyLedger, AlertCode, OrderStatus, ProductionOperation } from '../enums.js';
import {
  computeStockDeduction, computeCutVariance, computeCutOrderTotal, computeCuttableQty,
  type QtyCell, type AxisRef,
} from './quantities.js';
import { evaluateAlerts, type AlertContext } from './alerts.js';
import { deriveOrderStatus, type OrderStatusInput } from './progress.js';
import { computeProductionAnalytics } from './production.js';

describe('stock is netted per cell everywhere, not only on the cut order', () => {
  // Navy S 100 and White XL 100 ordered; 150 White XL already in the warehouse.
  const colors: AxisRef[] = [{ id: 'navy', name: 'Navy', position: 0 }, { id: 'white', name: 'White', position: 1 }];
  const sizes: AxisRef[] = [{ id: 's', name: 'S', position: 0 }, { id: 'xl', name: 'XL', position: 1 }];
  const cells: QtyCell[] = [
    { colorId: 'navy', sizeId: 's', ledger: QtyLedger.ORDER, qty: 100 },
    { colorId: 'white', sizeId: 'xl', ledger: QtyLedger.ORDER, qty: 100 },
    { colorId: 'white', sizeId: 'xl', ledger: QtyLedger.STOCK, qty: 150 },
    { colorId: 'navy', sizeId: 's', ledger: QtyLedger.CUT, qty: 105 },
  ];
  const cutOrder = computeCutOrderTotal(computeCuttableQty(cells, colors, sizes), 0.05);

  test('the cut order the Quantity tab generates', () => {
    assert.equal(cutOrder, 105);
  });

  test('the overview plans the same cut, with no phantom variance', () => {
    const v = computeCutVariance(cells, 0.05, null, colors, sizes);
    assert.equal(v.plannedCutQty, cutOrder, 'was 53 when netted on the totals');
    assert.equal(v.variance, 0, 'was +52');
  });

  test('required production is the Navy S that has to be made, and the figures add up', () => {
    const d = computeStockDeduction(cells, 0.05, colors, sizes);
    assert.equal(d.requiredProductionQty, 100, 'was 50 when netted on the totals');
    assert.equal(d.usableStockQty, 100, 'only the stock that covers an ordered cell is usable');
    assert.equal(d.customerOrderQty - d.usableStockQty, d.requiredProductionQty);
  });

  test('without axes the totals are still the fallback', () => {
    assert.equal(computeStockDeduction(cells, 0.05).requiredProductionQty, 50);
  });
});

const baseOrder: AlertContext['order'] = {
  poNumber: 'PO-1', orderQty: 1000, packedQty: 0, producedQty: 0, shippedQty: 0,
  requiredDeliveryDate: '2026-09-01', promisedShippingDate: '2026-08-25',
};
const today = new Date('2026-09-20');

describe('a cancelled outside operation is not a problem', () => {
  const ctx = (status: 'CANCELLED' | 'SENT'): AlertContext => ({
    today,
    order: { ...baseOrder, requiredDeliveryDate: '2026-12-01', promisedShippingDate: '2026-11-20' },
    tasks: [],
    externalOps: [{
      id: 'op1', operationType: 'PRINTING', status, requiresApproval: true, approvalCleared: false,
      expectedReturnDate: '2026-09-01', actualReturnDate: null,
    }],
  });

  test('it neither blocks nor runs late', () => {
    const codes = evaluateAlerts(ctx('CANCELLED')).map((a) => a.code);
    assert.ok(!codes.includes(AlertCode.EXTERNAL_OP_BLOCKED));
    assert.ok(!codes.includes(AlertCode.EXTERNAL_OP_LATE));
  });

  test('a live one still does both', () => {
    const codes = evaluateAlerts(ctx('SENT')).map((a) => a.code);
    assert.ok(codes.includes(AlertCode.EXTERNAL_OP_BLOCKED));
    assert.ok(codes.includes(AlertCode.EXTERNAL_OP_LATE));
  });
});

describe('an order that has shipped stops raising schedule alerts', () => {
  // Shipped late and short of the order quantity, sewn well behind plan.
  const production = computeProductionAnalytics({
    entries: [{ date: '2026-08-20', operation: ProductionOperation.SEWING, qty: 400 }],
    orderQty: 1000, cutQty: 1050, requiredDate: '2026-09-01', today,
  });
  const ctx = (finished: boolean): AlertContext => ({
    today, tasks: [], production,
    order: { ...baseOrder, producedQty: 400, packedQty: 300, shippedQty: 400, finished },
  });

  test('while it is still in the factory the alerts are right', () => {
    assert.ok(production.isBehindSchedule);
    const codes = evaluateAlerts(ctx(false)).map((a) => a.code);
    assert.ok(codes.includes(AlertCode.ORDER_OVERDUE));
    assert.ok(codes.includes(AlertCode.PRODUCTION_BEHIND));
  });

  test('once it has gone they are not', () => {
    const codes = evaluateAlerts(ctx(true)).map((a) => a.code);
    assert.ok(!codes.includes(AlertCode.ORDER_OVERDUE));
    assert.ok(!codes.includes(AlertCode.PRODUCTION_BEHIND));
    assert.ok(!codes.includes(AlertCode.PACKING_INCOMPLETE));
  });
});

describe('a passed final inspection clears Quality Check on its own', () => {
  const input: OrderStatusInput = {
    cancelled: false, hasOpenQualityFailure: false, shipmentStatus: null,
    orderQty: 1000, producedQty: 1000, packedQty: 0, shippedQty: 0,
    qualityPassedQty: 0, packingApproved: false, materialsFullyIssued: true,
    hasPendingBlockingApproval: false, isBehindSchedule: false, anyTaskStarted: true,
  };

  test('with nothing typed on the out-line ledger and no audit, it is waiting on quality', () => {
    assert.equal(deriveOrderStatus(input), OrderStatus.QUALITY_CHECK);
  });

  test('with a passing audit it is not', () => {
    assert.notEqual(deriveOrderStatus({ ...input, qualityAuditPassed: true }), OrderStatus.QUALITY_CHECK);
  });
});
