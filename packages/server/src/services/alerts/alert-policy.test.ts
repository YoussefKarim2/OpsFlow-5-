import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertCode } from '@opsflow/shared';
import { alertNotice } from './alert-policy.js';

test('a late outside operation is never emailed', () => {
  const n = alertNotice({
    code: AlertCode.EXTERNAL_OP_LATE, severity: 'WARNING',
    detail: 'Emb. Badges is 4 days past its expected return date.',
  });
  assert.equal(n.email, false);
});

test('every lateness and deadline reminder stays off email', () => {
  for (const code of [
    AlertCode.ORDER_OVERDUE, AlertCode.SHIP_DATE_APPROACHING, AlertCode.EXTERNAL_OP_LATE,
    AlertCode.PRODUCTION_BEHIND, AlertCode.TASK_OVERDUE, AlertCode.PACKING_INCOMPLETE,
    AlertCode.APPROVAL_PENDING,
  ]) {
    assert.equal(alertNotice({ code, severity: 'WARNING', detail: 'x' }).email, false, code);
  }
});

test('another day late is not news', () => {
  const day4 = alertNotice({
    code: AlertCode.EXTERNAL_OP_LATE, severity: 'WARNING',
    detail: 'Emb. Badges is 4 days past its expected return date.',
  });
  const day5 = alertNotice({
    code: AlertCode.EXTERNAL_OP_LATE, severity: 'WARNING',
    detail: 'Emb. Badges is 5 days past its expected return date.',
  });
  assert.equal(day4.snapshot, day5.snapshot);
});

test('becoming more serious is still news', () => {
  const a = alertNotice({ code: AlertCode.APPROVAL_PENDING, severity: 'WARNING', detail: 'x' });
  const b = alertNotice({ code: AlertCode.APPROVAL_PENDING, severity: 'CRITICAL', detail: 'x' });
  assert.notEqual(a.snapshot, b.snapshot);
});

test('a material shortage is still emailed, and a changed shortage is news', () => {
  const a = alertNotice({ code: AlertCode.MATERIAL_SHORTAGE, severity: 'CRITICAL', detail: 'Short by 50 m.' });
  const b = alertNotice({ code: AlertCode.MATERIAL_SHORTAGE, severity: 'CRITICAL', detail: 'Short by 80 m.' });
  assert.equal(a.email, true);
  assert.notEqual(a.snapshot, b.snapshot);
});
