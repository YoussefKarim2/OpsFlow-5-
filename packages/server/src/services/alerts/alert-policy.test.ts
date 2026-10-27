import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertCode } from '@opsflow/shared';
import { alertSnapshot, alertEntityId, alertKey, staleAlertStateIds } from './alert-policy.js';

test('another day late is not news, for every deadline reminder', () => {
  for (const code of [
    AlertCode.ORDER_OVERDUE, AlertCode.SHIP_DATE_APPROACHING, AlertCode.EXTERNAL_OP_LATE,
    AlertCode.PRODUCTION_BEHIND, AlertCode.TASK_OVERDUE, AlertCode.PACKING_INCOMPLETE,
    AlertCode.APPROVAL_PENDING,
  ]) {
    assert.equal(
      alertSnapshot({ code, severity: 'WARNING', detail: 'Emb. Badges is 4 days past its expected return date.' }),
      alertSnapshot({ code, severity: 'WARNING', detail: 'Emb. Badges is 5 days past its expected return date.' }),
      code,
    );
  }
});

test('becoming more serious is still news', () => {
  assert.notEqual(
    alertSnapshot({ code: AlertCode.APPROVAL_PENDING, severity: 'WARNING', detail: 'x' }),
    alertSnapshot({ code: AlertCode.APPROVAL_PENDING, severity: 'CRITICAL', detail: 'x' }),
  );
});

test('an alert with no record of its own is kept against the order and its title', () => {
  assert.equal(alertEntityId('o1', { title: 'Cutting is blocked' }), 'o1:cutting-is-blocked');
  assert.equal(alertEntityId('o1', { title: 'Late', entityId: 'op7' }), 'op7');
});

test('an alert that stopped firing is forgotten, so its return is news again', () => {
  const own = new Set(['task-1', 'op-1']);
  const states = [
    // Still firing: kept.
    { id: 's1', code: AlertCode.MATERIAL_SHORTAGE, entityId: 'o1:not-enough-stock-for-1-material' },
    // Stopped firing on this order: forgotten.
    { id: 's2', code: AlertCode.STAGE_BLOCKED, entityId: 'o1:cutting-is-blocked' },
    { id: 's3', code: AlertCode.EXTERNAL_OP_LATE, entityId: 'op-1' },
    // Another order's row, or a record that is not this order's: not touched.
    { id: 's4', code: AlertCode.STAGE_BLOCKED, entityId: 'o10:cutting-is-blocked' },
    { id: 's5', code: AlertCode.EXTERNAL_OP_LATE, entityId: 'op-9' },
  ];
  const fired = new Set([alertKey(AlertCode.MATERIAL_SHORTAGE, 'o1:not-enough-stock-for-1-material')]);
  assert.deepEqual(staleAlertStateIds('o1', own, states, fired), ['s2', 's3']);
});

test('the same record under another code is a different alert', () => {
  const states = [{ id: 's1', code: AlertCode.TASK_OVERDUE, entityId: 'task-1' }];
  const fired = new Set([alertKey(AlertCode.STAGE_BLOCKED, 'task-1')]);
  assert.deepEqual(staleAlertStateIds('o1', new Set(['task-1']), states, fired), ['s1']);
});

test('a changed shortage is news', () => {
  assert.notEqual(
    alertSnapshot({ code: AlertCode.MATERIAL_SHORTAGE, severity: 'CRITICAL', detail: 'Short by 50 m.' }),
    alertSnapshot({ code: AlertCode.MATERIAL_SHORTAGE, severity: 'CRITICAL', detail: 'Short by 80 m.' }),
  );
});
