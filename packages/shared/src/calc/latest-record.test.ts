import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { furthestShipmentStatus, recordedCutQty } from './quantities.js';
import { deriveOrderStatus } from './progress.js';

/**
 * "The latest record", when there is no such thing.
 *
 * Three places asked a relation for its last row — the latest shipment, the
 * latest packing list, the latest cutting record — against queries that never
 * ordered them. Postgres returns rows in whatever order it likes, so the answer
 * could change between two reads of the same unchanged order, and with it the
 * order's status.
 *
 * The queries are ordered now. These tests hold the two readings that were also
 * wrong on their own terms, regardless of row order.
 */
describe('how far an order has got with shipping', () => {
  test('the furthest consignment answers it, not the newest row', () => {
    // One gone, one still being prepared. The order has shipped.
    const shipments = [{ status: 'SHIPPED' }, { status: 'NOT_READY' }];
    assert.equal(furthestShipmentStatus(shipments), 'SHIPPED');
    assert.equal(furthestShipmentStatus([...shipments].reverse()), 'SHIPPED',
      'and the answer does not depend on the order of the rows');
  });

  test('delivered outranks shipped', () => {
    assert.equal(furthestShipmentStatus([{ status: 'SHIPPED' }, { status: 'DELIVERED' }]), 'DELIVERED');
  });

  test('the ladder runs not-ready → ready → booked → shipped → delivered', () => {
    const ladder = ['NOT_READY', 'READY', 'BOOKED', 'SHIPPED', 'DELIVERED'];
    for (let i = 1; i < ladder.length; i += 1) {
      assert.equal(
        furthestShipmentStatus([{ status: ladder[i - 1]! }, { status: ladder[i]! }]),
        ladder[i],
        `${ladder[i]} should outrank ${ladder[i - 1]}`,
      );
    }
  });

  test('no consignments is null, not a status', () => {
    assert.equal(furthestShipmentStatus([]), null);
  });

  test('adding a draft consignment cannot un-ship an order', () => {
    // The regression this prevents: a second row entered as NOT_READY used to
    // be capable of becoming "the latest shipment" and dragging the order back.
    const base = {
      cancelled: false, hasOpenQualityFailure: false, orderQty: 1000,
      producedQty: 1000, packedQty: 1000, shippedQty: 1000, qualityPassedQty: 1000,
      packingApproved: true, materialsFullyIssued: true,
      hasPendingBlockingApproval: false, isBehindSchedule: false, anyTaskStarted: true,
    };
    const shipments = [{ status: 'DELIVERED' as const }, { status: 'NOT_READY' as const }];
    assert.equal(
      deriveOrderStatus({ ...base, shipmentStatus: furthestShipmentStatus(shipments) }),
      'COMPLETED',
    );
  });
});

describe('how many pieces were actually cut', () => {
  test('the recorded quantities add up — the log is additive', () => {
    assert.equal(recordedCutQty([{ actualCutQty: 400 }, { actualCutQty: 650 }]), 1050);
  });

  test('rows carrying no quantity are ignored, not treated as the answer', () => {
    // A Laying & Marking import writes a row for the date and the cutter with
    // no quantity. Reading the last row would have thrown away the real one.
    assert.equal(recordedCutQty([{ actualCutQty: 1050 }, { actualCutQty: null }]), 1050);
    assert.equal(recordedCutQty([{ actualCutQty: null }, { actualCutQty: 1050 }]), 1050);
  });

  test('nothing recorded is null, so the cut ledger still answers', () => {
    assert.equal(recordedCutQty([]), null);
    assert.equal(recordedCutQty([{ actualCutQty: null }, {}]), null);
  });

  test('a zero cut is an answer, not an absence', () => {
    assert.equal(recordedCutQty([{ actualCutQty: 0 }]), 0);
  });

  test('the order of the rows never changes the total', () => {
    const rows = [{ actualCutQty: 12 }, { actualCutQty: null }, { actualCutQty: 30 }, { actualCutQty: 5 }];
    assert.equal(recordedCutQty(rows), 47);
    assert.equal(recordedCutQty([...rows].reverse()), 47);
  });
});
