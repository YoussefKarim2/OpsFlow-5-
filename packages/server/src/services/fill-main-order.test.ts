import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ImportIssue } from '@opsflow/shared';
import { documentPoVerdict, samePo } from './fill-main-order.js';

/**
 * Which documents may fill an empty Main Order, judged by the PO they state.
 *
 * The audit's case: a "Customer PO" attached to the wrong order was trusted
 * outright, and filled that order with another order's quantities.
 */
const doc = (poNumber: string | null, issues: Array<Pick<ImportIssue, 'level' | 'field'>> = []) => ({
  fields: { poNumber },
  issues: issues.map((i) => ({ ...i, sheet: null, cell: null, message: '' })) as ImportIssue[],
});
const customerPo = { trusted: true, importedFrom: false };
const importFile = { trusted: true, importedFrom: true };
const reference = { trusted: false, importedFrom: false };

describe('filling a Main Order from a document', () => {
  test('a Customer PO that states another PO is refused (t14: 219 attached to 178)', () => {
    assert.equal(documentPoVerdict(customerPo, doc('219'), '178'), 'OTHER_PO');
  });

  test('a Customer PO that states this PO, or none, is used', () => {
    assert.equal(documentPoVerdict(customerPo, doc('178'), '178'), 'USE');
    assert.equal(documentPoVerdict(customerPo, doc('PO-178'), '178'), 'USE', '"PO-178" and "178" are one number');
    assert.equal(documentPoVerdict(customerPo, doc(null), '178'), 'USE');
  });

  test('a PO the reader guessed or made up is not "stated"', () => {
    const guessed = doc('IMPORT-2026-10-27-AB12', [{ level: 'WARNING', field: 'poNumber' }]);
    assert.equal(documentPoVerdict(customerPo, guessed, '178'), 'USE');
  });

  test('the file the order was imported from is used even after a rename', () => {
    assert.equal(documentPoVerdict(importFile, doc('178'), '178-A'), 'USE');
  });

  test('any other reference document must show this order\'s PO', () => {
    assert.equal(documentPoVerdict(reference, doc('178'), '178'), 'USE');
    assert.equal(documentPoVerdict(reference, doc(null), '178'), 'NOT_SHOWN');
    assert.equal(documentPoVerdict(reference, doc('219'), '178'), 'OTHER_PO');
  });

  test('PO numbers compare without case, spacing or a leading "PO", and nothing looser', () => {
    assert.ok(samePo(' po 4500 ', '4500'));
    assert.ok(samePo('P.O. No. 4500', '4500'));
    assert.ok(!samePo('17-8', '1-78'));
    assert.ok(!samePo(null, '178'));
  });
});
