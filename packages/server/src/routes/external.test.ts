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
