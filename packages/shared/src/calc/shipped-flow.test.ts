import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { QtyLedger } from '../enums.js';
import { computeFunnel, computeVariances, resolveShippedQty, type QtyCell } from './quantities.js';
import { computeCosting } from './costing.js';
import { deriveOrderStatus } from './progress.js';
import { evaluateAlerts } from './alerts.js';

/**
 * Shipped quantity, recorded once.
 *
 * Two records can answer "how many shipped": the colour × size grid on the
 * Quantity tab, and the consignments recorded on Packing & Shipping with a
 * carrier and a date. Only the grid was ever read, so recording a shipment
 * moved nothing — the order never reached its shipped status, the costing went
 * on saying it was waiting for a shipped quantity, and the only way to make
 * either work was to type the figure a second time somewhere else.
 */
const cell = (colorId: string, sizeId: string, ledger: QtyLedger, qty: number): QtyCell =>
  ({ colorId, sizeId, ledger, qty });

const ORDERED = [cell('navy', 's', QtyLedger.ORDER, 1000)];
const PACKED = [...ORDERED, cell('navy', 's', QtyLedger.PACKED, 1000)];

describe('where the shipped figure comes from', () => {
  test('the grid answers it when somebody has filled the grid', () => {
    const cells = [...PACKED, cell('navy', 's', QtyLedger.SHIPPED, 900)];
    assert.equal(resolveShippedQty(cells, []), 900);
  });

  test('a recorded consignment answers it when the grid is empty', () => {
    assert.equal(resolveShippedQty(PACKED, [{ qty: 1000, status: 'SHIPPED' }]), 1000);
  });

  test('the grid wins when both exist — it is the more specific record', () => {
    const cells = [...PACKED, cell('navy', 's', QtyLedger.SHIPPED, 900)];
    assert.equal(resolveShippedQty(cells, [{ qty: 1000, status: 'SHIPPED' }]), 900);
  });

  test('consignments that have not left are not counted', () => {
    for (const status of ['NOT_READY', 'READY', 'BOOKED']) {
      assert.equal(resolveShippedQty(PACKED, [{ qty: 1000, status }]), 0, `${status} has not shipped`);
    }
    assert.equal(resolveShippedQty(PACKED, [{ qty: 1000, status: 'DELIVERED' }]), 1000);
  });

  test('several consignments add up', () => {
    assert.equal(resolveShippedQty(PACKED, [
      { qty: 400, status: 'SHIPPED' }, { qty: 350, status: 'DELIVERED' }, { qty: 250, status: 'BOOKED' },
    ]), 750);
  });

  test('nothing recorded anywhere is zero, not a guess', () => {
    assert.equal(resolveShippedQty(PACKED, []), 0);
  });
});

describe('what a recorded consignment now moves', () => {
  const shipments = [{ qty: 1000, status: 'SHIPPED' }];

  test('the funnel', () => {
    const before = computeFunnel(PACKED, []);
    const after = computeFunnel(PACKED, shipments);
    assert.equal(before.find((f) => f.ledger === QtyLedger.SHIPPED)!.qty, 0);
    assert.equal(after.find((f) => f.ledger === QtyLedger.SHIPPED)!.qty, 1000);
  });

  test('the order status', () => {
    const base = {
      cancelled: false, hasOpenQualityFailure: false, shipmentStatus: null,
      orderQty: 1000, producedQty: 1000, packedQty: 1000, qualityPassedQty: 1000,
      packingApproved: true, materialsFullyIssued: true, hasPendingBlockingApproval: false,
      isBehindSchedule: false, anyTaskStarted: true,
    };
    assert.notEqual(deriveOrderStatus({ ...base, shippedQty: 0 }), 'SHIPPED');
    assert.equal(deriveOrderStatus({ ...base, shippedQty: resolveShippedQty(PACKED, shipments) }), 'SHIPPED');
  });

  test('the costing — unit cost, profit and the difference', () => {
    const costingInput = {
      orderQty: 1000, cutQty: 1050, dollarRate: 48.5, dailyCostEgp: 1867,
      machineCount: 38, machineDaysUsed: 38, daysInLine: 11, sellPriceUsd: 10,
      lines: [{ group: 'FABRIC' as const, label: 'F', quantity: 100, unit: 'M', unitPriceUsd: 5 }],
    };
    const stranded = computeCosting({ ...costingInput, shippedQty: resolveShippedQty(PACKED, []) || null });
    assert.equal(stranded.unitActualCostUsd, null);
    assert.match(stranded.waiting.unitActualCostUsd!, /shipped quantity/);

    const flowing = computeCosting({ ...costingInput, shippedQty: resolveShippedQty(PACKED, shipments) });
    assert.ok(Math.abs(flowing.unitActualCostUsd! - flowing.totalCostUsd! / 1000) < 1e-12);
    assert.ok(flowing.profitPerUnitUsd !== null);
    assert.equal(flowing.diffPct, 0, 'shipped exactly what was ordered');
    assert.equal(flowing.waiting.unitActualCostUsd, undefined);
  });

  test('the variance table, so it cannot contradict the funnel', () => {
    const shipped = resolveShippedQty(PACKED, shipments);
    const stale = computeVariances(PACKED);
    const fresh = computeVariances(PACKED, shipped);
    const pick = (rows: ReturnType<typeof computeVariances>) =>
      rows.find((r) => r.from === QtyLedger.PACKED && r.to === QtyLedger.SHIPPED)!;
    assert.equal(pick(stale).variance, -1000, 'the grid alone says a thousand went missing');
    assert.equal(pick(fresh).variance, 0, 'the consignment says they shipped');
  });

  test('a part shipment moves everything by the right amount', () => {
    const part = [{ qty: 600, status: 'SHIPPED' }];
    assert.equal(resolveShippedQty(PACKED, part), 600);
    assert.equal(computeFunnel(PACKED, part).find((f) => f.ledger === QtyLedger.SHIPPED)!.qty, 600);
    const c = computeCosting({
      orderQty: 1000, cutQty: 1050, shippedQty: resolveShippedQty(PACKED, part),
      dollarRate: 48.5, dailyCostEgp: null, machineCount: null, machineDaysUsed: null,
      daysInLine: null, sellPriceUsd: 10,
      lines: [{ group: 'FABRIC', label: 'F', quantity: 100, unit: 'M', unitPriceUsd: 5 }],
    });
    assert.equal(c.unitActualCostUsd, 500 / 600);
    assert.ok(Math.abs(c.diffPct! + 40) < 1e-9, 'forty per cent short of the order');
  });

  test('nothing here can produce an unrenderable number', () => {
    for (const shipments of [[], [{ qty: 0, status: 'SHIPPED' }], [{ qty: 1, status: 'BOOKED' }]]) {
      const q = resolveShippedQty([], shipments);
      assert.ok(Number.isFinite(q));
      for (const step of computeFunnel([], shipments)) {
        assert.ok(Number.isFinite(step.qty));
        assert.ok(step.pctOfOrder === null || Number.isFinite(step.pctOfOrder));
      }
    }
  });
});

describe('an order that has shipped stops being overdue', () => {
  const base = {
    today: new Date('2026-06-01T00:00:00Z'),
    order: {
      poNumber: 'PO-1',
      requiredDeliveryDate: '2026-05-01T00:00:00Z',   // a month ago
      promisedShippingDate: '2026-04-20T00:00:00Z',
      orderQty: 1000, packedQty: 0, producedQty: 1000,
    },
    tasks: [],
  };
  const overdue = (alerts: ReturnType<typeof evaluateAlerts>) =>
    alerts.some((a) => a.code === 'ORDER_OVERDUE');

  test('past its date with nothing packed or shipped, it is overdue', () => {
    assert.equal(overdue(evaluateAlerts(base)), true);
  });

  test('shipped in full, it is not — the consignments are the evidence', () => {
    // Before this, only the packed ledger was consulted, so an order whose
    // cartons were never entered on the grid went on raising an alert that
    // nobody could clear.
    assert.equal(overdue(evaluateAlerts({
      ...base, order: { ...base.order, shippedQty: 1000 },
    })), false);
  });

  test('a part shipment does not clear it', () => {
    assert.equal(overdue(evaluateAlerts({
      ...base, order: { ...base.order, shippedQty: 600 },
    })), true);
  });

  test('the alert returns if the shipment is undone', () => {
    // Alerts are recomputed from the current facts every time they are read,
    // so nothing has to be un-resolved by hand.
    const shipped = evaluateAlerts({ ...base, order: { ...base.order, shippedQty: 1000 } });
    const reverted = evaluateAlerts({ ...base, order: { ...base.order, shippedQty: 0 } });
    assert.equal(overdue(shipped), false);
    assert.equal(overdue(reverted), true);
  });
});
