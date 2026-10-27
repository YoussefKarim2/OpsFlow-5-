import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bulkUpdateData } from './external.js';

/**
 * Order Details and the External Order stage both save these rows, and they
 * edit different halves of one. Details knows what kind of work the order needs;
 * the external team knows the factory, the price and the dates. Whichever saves
 * second must not erase what the other entered.
 */
describe('bulk-saving external work', () => {
  test('a field the caller did not send is left alone, not cleared', () => {
    // What Order Details sends: the work, and nothing about scheduling.
    const data = bulkUpdateData({
      id: 'op1', operationType: 'Print Back', operationSort: 'Print', qty: 0,
    });

    for (const untouched of ['expectedReturnDate', 'requiresApproval', 'colorIds', 'unitPriceUsd']) {
      assert.equal(
        untouched in data, false,
        `${untouched} must not be written by a caller that never mentioned it`,
      );
    }
    assert.equal(data.operationType, 'Print Back');
  });

  test('an explicitly null date does clear it', () => {
    // The distinction that matters: absent means unchanged, null means remove.
    const data = bulkUpdateData({ id: 'op1', operationType: 'Print Back', expectedReturnDate: null });
    assert.equal('expectedReturnDate' in data, true);
    assert.equal(data.expectedReturnDate, null);
  });

  test('a date that was sent is stored as a date, not a string', () => {
    const data = bulkUpdateData({
      id: 'op1', operationType: 'Print Back', expectedReturnDate: '2026-10-01',
    });
    assert.ok(data.expectedReturnDate instanceof Date);
    assert.equal((data.expectedReturnDate as Date).toISOString().slice(0, 10), '2026-10-01');
  });

  test('the row id is never part of the update payload', () => {
    // It addresses the row; writing it back would be a no-op at best.
    const data = bulkUpdateData({ id: 'op1', operationType: 'Emb. Sleeves' });
    assert.equal('id' in data, false);
  });
});

describe('work that has been sent keeps its quantity and price', () => {
  test('a sent row ignores a changed quantity and price but takes its notes', () => {
    const data = bulkUpdateData(
      { id: 'op1', operationType: 'Print Back', qty: 999, unitPriceUsd: 9, unitRate: 9, notes: 'late' },
      'SENT',
    );
    for (const k of ['qty', 'unitPriceUsd', 'unitRate']) assert.equal(k in data, false, k);
    assert.equal(data.notes, 'late');
  });

  test('a row not yet sent is edited in full', () => {
    const data = bulkUpdateData({ id: 'op1', operationType: 'Print Back', qty: 500, unitPriceUsd: 0.2 }, 'NOT_SENT');
    assert.equal(data.qty, 500);
    assert.equal(data.unitPriceUsd, 0.2);
  });

  test('cleared factory, reference and notes are written as null', () => {
    const data = bulkUpdateData({
      id: 'op1', operationType: 'Print Back', externalFactoryId: null, externalReference: null, notes: null,
    });
    assert.equal(data.externalFactoryId, null);
    assert.equal(data.externalReference, null);
    assert.equal(data.notes, null);
  });
});

describe('external work only moves forward', () => {
  test('forward moves are allowed, steps may be skipped', async () => {
    const { canMoveStatus } = await import('./external.js');
    assert.ok(canMoveStatus('NOT_SENT', 'SENT'));
    assert.ok(canMoveStatus('SENT', 'IN_PROGRESS'));
    assert.ok(canMoveStatus('SENT', 'RETURNED'));
    assert.ok(canMoveStatus('WAITING_APPROVAL', 'SENT'), 'an old waiting row is not sent');
  });

  test('backwards and sideways moves are refused', async () => {
    const { canMoveStatus } = await import('./external.js');
    assert.equal(canMoveStatus('RETURNED', 'NOT_SENT'), false);
    assert.equal(canMoveStatus('IN_PROGRESS', 'SENT'), false);
    assert.equal(canMoveStatus('SENT', 'SENT'), false);
  });

  test('cancelled from anywhere, and nothing out of cancelled', async () => {
    const { canMoveStatus } = await import('./external.js');
    for (const s of ['NOT_SENT', 'SENT', 'IN_PROGRESS', 'RETURNED']) assert.ok(canMoveStatus(s, 'CANCELLED'), s);
    assert.equal(canMoveStatus('CANCELLED', 'SENT'), false);
    assert.equal(canMoveStatus('CANCELLED', 'CANCELLED'), false);
  });
});

describe('outside work no longer waits for customer approval', () => {
  test('an operation stored as waiting for approval reads as not sent', async () => {
    const { asNotSent } = await import('./external.js');
    assert.equal(asNotSent('WAITING_APPROVAL'), 'NOT_SENT');
    for (const s of ['NOT_SENT', 'SENT', 'IN_PROGRESS', 'RETURNED', 'CANCELLED']) assert.equal(asNotSent(s), s);
  });
});
