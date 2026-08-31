/**
 * Folding a request's changes into one announcement.
 *
 * This is the piece that makes "quantity, delivery date and coordinator all
 * changed" into one notification and one email rather than three of each — the
 * brief's §7, and the single most visible thing about the feature when it is
 * wrong.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { foldChanges } from './change-fold.js';
import type { ChangeDraft } from '../request-context.js';

const draft = (over: Partial<ChangeDraft> = {}): ChangeDraft => ({
  model: 'Order',
  action: 'UPDATE',
  entityId: 'order-1',
  orderId: 'order-1',
  field: 'orderName',
  oldValue: 'A',
  newValue: 'B',
  subjectHint: null,
  ...over,
});

describe('one user action becomes one change', () => {
  test('three fields on one order fold into a single event', () => {
    const folded = foldChanges([
      draft({ field: 'qty', oldValue: '300', newValue: '350' }),
      draft({ field: 'requiredDeliveryDate', oldValue: '2026-09-03', newValue: '2026-09-05' }),
      draft({ field: 'coordinatorId', oldValue: 'u1', newValue: 'u2' }),
    ]);

    assert.equal(folded.length, 1, 'one action, one announcement');
    assert.equal(folded[0]!.fields.length, 3, 'and it carries all three changes');
    assert.deepEqual(
      folded[0]!.fields.map((f) => f.field),
      ['qty', 'requiredDeliveryDate', 'coordinatorId'],
    );
  });

  test('every field arrives already labelled for a person', () => {
    const folded = foldChanges([draft({ field: 'promisedShippingDate' })]);
    assert.equal(folded[0]!.fields[0]!.label, 'Promised shipping date');
  });

  test('two different records are two changes, because a person reads two lines', () => {
    const folded = foldChanges([
      draft({ model: 'Order', entityId: 'order-1', field: 'qty' }),
      draft({ model: 'ProductionRecord', action: 'CREATE', entityId: 'prod-9', field: 'qty', oldValue: null, newValue: '150' }),
    ]);
    assert.equal(folded.length, 2);
    assert.deepEqual(folded.map((f) => f.model).sort(), ['Order', 'ProductionRecord']);
  });

  test('a create and an update on the same record stay apart', () => {
    // They are different sentences: "created" and "changed" are not one event.
    const folded = foldChanges([
      draft({ model: 'Approval', action: 'CREATE', entityId: 'a1', field: 'type', oldValue: null, newValue: 'PRINT' }),
      draft({ model: 'Approval', action: 'UPDATE', entityId: 'a1', field: 'status', oldValue: 'PENDING', newValue: 'APPROVED' }),
    ]);
    assert.equal(folded.length, 2);
  });
});

describe('the same field written twice in one request', () => {
  test('keeps the first before and the last after — what actually happened', () => {
    // A service that writes, recomputes and writes again should not produce
    // "300 → 320" followed by "320 → 350". End to end it went 300 → 350.
    const folded = foldChanges([
      draft({ field: 'qty', oldValue: '300', newValue: '320' }),
      draft({ field: 'qty', oldValue: '320', newValue: '350' }),
    ]);

    assert.equal(folded.length, 1);
    assert.equal(folded[0]!.fields.length, 1);
    assert.equal(folded[0]!.fields[0]!.oldValue, '300');
    assert.equal(folded[0]!.fields[0]!.newValue, '350');
  });
});

describe('noise is left out', () => {
  test('bookkeeping columns never reach a notification', () => {
    const folded = foldChanges([
      draft({ field: 'updatedAt', oldValue: 'a', newValue: 'b' }),
      draft({ field: 'cachedProgressPct', oldValue: '30', newValue: '36' }),
      draft({ field: 'position', oldValue: '1', newValue: '2' }),
    ]);
    assert.equal(folded.length, 0, 'a request that only touched noise says nothing');
  });

  test('a real change alongside noise keeps only the real one', () => {
    const folded = foldChanges([
      draft({ field: 'updatedAt', oldValue: 'a', newValue: 'b' }),
      draft({ field: 'orderName', oldValue: 'Florida T', newValue: 'Florida T Shirt' }),
    ]);
    assert.equal(folded.length, 1);
    assert.deepEqual(folded[0]!.fields.map((f) => f.field), ['orderName']);
  });

  test('a model nobody asked to track produces nothing', () => {
    const folded = foldChanges([draft({ model: 'ImportJob', field: 'status' })]);
    assert.equal(folded.length, 0);
  });
});

describe('what the event knows about itself', () => {
  test('the order id is learned from whichever draft has it', () => {
    // A create often learns its own order only once the row is written.
    const folded = foldChanges([
      draft({ model: 'Attachment', action: 'CREATE', entityId: 'f1', orderId: null, field: 'fileName', oldValue: null, newValue: 'artwork.pdf' }),
      draft({ model: 'Attachment', action: 'CREATE', entityId: 'f1', orderId: 'order-7', field: 'documentType', oldValue: null, newValue: 'ARTWORK' }),
    ]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0]!.orderId, 'order-7');
  });

  test('the subject is taken from whichever draft could name the record', () => {
    const folded = foldChanges([
      draft({ model: 'Material', action: 'CREATE', entityId: 'm1', orderId: null, subjectHint: null, field: 'type', oldValue: null, newValue: 'FABRIC' }),
      draft({ model: 'Material', action: 'CREATE', entityId: 'm1', orderId: null, subjectHint: 'Rosetta Jersey', field: 'name', oldValue: null, newValue: 'Rosetta Jersey' }),
    ]);
    assert.equal(folded[0]!.subjectHint, 'Rosetta Jersey');
  });

  test('a create with no fields still counts as news', () => {
    // "A packing list was created" is worth saying even with nothing to diff.
    const folded = foldChanges([
      draft({ model: 'PackingList', action: 'CREATE', entityId: 'p1', field: 'position', oldValue: null, newValue: '0' }),
    ]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0]!.action, 'CREATE');
    assert.equal(folded[0]!.fields.length, 0, 'the only field was noise, but the create remains');
  });

  test('an update whose every field was noise is dropped entirely', () => {
    const folded = foldChanges([
      draft({ model: 'Order', action: 'UPDATE', field: 'updatedAt', oldValue: 'a', newValue: 'b' }),
    ]);
    assert.equal(folded.length, 0);
  });
});

describe('nothing in, nothing out', () => {
  test('an empty request produces no events', () => {
    assert.deepEqual(foldChanges([]), []);
  });
});
