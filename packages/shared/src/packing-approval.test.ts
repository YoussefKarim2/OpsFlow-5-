import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packingListsApproved } from './packing-approval.js';

test('packing is approved when every list with cartons is, whatever was created last', () => {
  const approvedFull = { approved: true, cartons: [1] };
  assert.equal(packingListsApproved([approvedFull, { approved: false, cartons: [] }]), true, 'an empty new list does not un-approve');
  assert.equal(packingListsApproved([{ approved: false, cartons: [1] }, approvedFull]), false, 'an older unapproved list is not hidden');
  assert.equal(packingListsApproved([]), false);
  assert.equal(packingListsApproved([{ approved: true, cartons: [] }]), false);
});
