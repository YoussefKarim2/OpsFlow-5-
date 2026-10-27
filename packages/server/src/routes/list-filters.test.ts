/**
 * What the lists show: the Follow-Up Centre, the What Changed date window and
 * the Orders list's Cancelled filter.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { followUpShowsAlert } from './dashboard.js';
import { createdAtWindow } from './changes.js';
import { includesCancelled } from '../services/order-service.js';

describe('the Follow-Up Centre', () => {
  test('lists each overdue task once — as its own row, not again as a summary', () => {
    assert.equal(followUpShowsAlert('TASK_OVERDUE', false), false);
    assert.equal(followUpShowsAlert('TASK_OVERDUE', true), false);
  });

  test('an open order shows its alerts', () => {
    for (const code of ['ORDER_OVERDUE', 'MATERIAL_SHORTAGE', 'STAGE_BLOCKED', 'QUALITY_FAILED']) {
      assert.ok(followUpShowsAlert(code, false), code);
    }
  });

  test('a shipped or completed order shows only an open quality failure', () => {
    assert.ok(followUpShowsAlert('QUALITY_FAILED', true));
    for (const code of ['MATERIAL_SHORTAGE', 'MATERIAL_UNRESERVED', 'STAGE_BLOCKED', 'CONSUMPTION_VARIANCE']) {
      assert.equal(followUpShowsAlert(code, true), false, code);
    }
  });
});

describe('the What Changed date window', () => {
  test('instants from the page are used as sent: from inclusive, to exclusive', () => {
    // Cairo, UTC+3: the 5th runs from 21:00 UTC on the 4th to 21:00 on the 5th.
    const w = createdAtWindow('2026-10-04T21:00:00.000Z', '2026-10-05T21:00:00.000Z');
    assert.deepEqual(w, {
      gte: new Date('2026-10-04T21:00:00.000Z'),
      lt: new Date('2026-10-05T21:00:00.000Z'),
    });
  });

  test('a bare date still means that whole UTC day, as old links expect', () => {
    const w = createdAtWindow('2026-10-05', '2026-10-05');
    assert.deepEqual(w, {
      gte: new Date('2026-10-05T00:00:00.000Z'),
      lt: new Date('2026-10-06T00:00:00.000Z'),
    });
  });

  test('either end may be left open, and no dates is no window', () => {
    assert.deepEqual(createdAtWindow('2026-10-05', undefined), { gte: new Date('2026-10-05T00:00:00.000Z') });
    assert.deepEqual(createdAtWindow(undefined, '2026-10-05T21:00:00.000Z'), { lt: new Date('2026-10-05T21:00:00.000Z') });
    assert.equal(createdAtWindow(undefined, undefined), undefined);
  });
});

describe('the Orders list', () => {
  test('hides cancelled orders by default', () => {
    assert.equal(includesCancelled({}), false);
    assert.equal(includesCancelled({ status: 'IN_PRODUCTION' }), false);
  });

  test('asking for the Cancelled status is asking for cancelled orders', () => {
    assert.equal(includesCancelled({ status: 'CANCELLED' }), true);
  });

  test('or asking for them outright', () => {
    assert.equal(includesCancelled({ includeCancelled: true }), true);
  });
});
