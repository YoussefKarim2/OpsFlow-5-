import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertCode } from '@opsflow/shared';
import { alertSnapshot } from './alert-policy.js';

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

test('a changed shortage is news', () => {
  assert.notEqual(
    alertSnapshot({ code: AlertCode.MATERIAL_SHORTAGE, severity: 'CRITICAL', detail: 'Short by 50 m.' }),
    alertSnapshot({ code: AlertCode.MATERIAL_SHORTAGE, severity: 'CRITICAL', detail: 'Short by 80 m.' }),
  );
});
