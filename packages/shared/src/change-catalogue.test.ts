/**
 * What a change means.
 *
 * These cover the rules a factory notices when they are wrong: a delivery date
 * arriving as LOW priority, a date shown as `2026-09-05T00:00:00.000Z`, an
 * empty value rendered as `0`, or three edited fields described as three
 * separate things.
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { NotificationPriority, ChangeCategory } from './enums.js';
import {
  TRACKED_MODELS, fieldLabel, formatValue, derivePriority, summariseChange,
  describeFieldChange, highestPriority, CATEGORY_LABEL, PRIORITY_STYLE,
  isSignificantQtyChange,
  type FieldChange,
} from './change-catalogue.js';

const f = (
  field: string, oldValue: string | null, newValue: string | null,
): FieldChange => ({ field, label: fieldLabel(field), oldValue, newValue });

describe('a column name becomes something a person can read', () => {
  test('the ones that matter are named by hand', () => {
    assert.equal(fieldLabel('promisedShippingDate'), 'Promised shipping date');
    assert.equal(fieldLabel('poNumber'), 'PO number');
    assert.equal(fieldLabel('coordinatorId'), 'Coordinator');
    assert.equal(fieldLabel('pricePerPieceUsd'), 'Price per piece (USD)');
  });

  test('the rest fall back to something reasonable rather than the raw column', () => {
    assert.equal(fieldLabel('orderName'), 'Order name');
    assert.equal(fieldLabel('shippingMethod'), 'Shipping method');
    // Never the camelCase original — that is the thing being avoided.
    assert.ok(!fieldLabel('someNewColumn').includes('someNewColumn'));
  });
});

describe('values are formatted, and never invented', () => {
  test('a stored timestamp reads as a date', () => {
    assert.equal(formatValue('2026-09-05T00:00:00.000Z'), '5 September 2026');
    assert.equal(formatValue('2026-09-03'), '3 September 2026');
  });

  test('numbers get separators, decimals keep their precision', () => {
    assert.equal(formatValue('1972'), '1,972');
    assert.equal(formatValue('1194.0000'), '1,194');
    assert.equal(formatValue('7.25'), '7.25');
  });

  test('an enum reads as words', () => {
    assert.equal(formatValue('PRODUCTION_DELAYED'), 'Production delayed');
    // "Result: Pending → Fail" is what a person would write. The shouting
    // version is a database value, not a sentence.
    assert.equal(formatValue('FAIL'), 'Fail');
    assert.equal(formatValue('PENDING'), 'Pending');
  });

  test('formatting for display does not change what priority sees', () => {
    // derivePriority reads the *raw* value, so a FAIL still registers as
    // urgent even though the screen will say "Fail".
    assert.equal(
      derivePriority('QualityAudit', 'UPDATE', [f('result', 'PENDING', 'FAIL')]),
      NotificationPriority.URGENT,
    );
  });

  test('booleans read as yes and no', () => {
    assert.equal(formatValue('true'), 'Yes');
    assert.equal(formatValue('false'), 'No');
  });

  test('nothing becomes null, and stays null', () => {
    // The workbook this replaces showed 0 where it meant "nobody entered
    // anything". A change log that repeats that is worse than useless.
    assert.equal(formatValue(null), null);
    assert.equal(formatValue(''), null);
    assert.equal(formatValue('   '), null);
  });

  test('an id is not information, so it is not shown as if it were', () => {
    assert.equal(formatValue('cm3k9xq2p0001abcdefghijkl'), null);
  });
});

describe('priority is derived from what changed, not chosen by the caller', () => {
  test('a delivery date is always high, whatever it sits on', () => {
    assert.equal(
      derivePriority('Order', 'UPDATE', [f('requiredDeliveryDate', '2026-09-03', '2026-09-05')]),
      NotificationPriority.HIGH,
    );
    assert.equal(
      derivePriority('Shipment', 'UPDATE', [f('promisedShippingDate', null, '2026-09-05')]),
      NotificationPriority.HIGH,
    );
  });

  test('a routine production record is normal', () => {
    assert.equal(
      derivePriority('ProductionRecord', 'CREATE', [f('qty', null, '150')]),
      NotificationPriority.NORMAL,
    );
  });

  test('a failed quality audit is urgent', () => {
    assert.equal(
      derivePriority('QualityAudit', 'UPDATE', [f('result', 'PENDING', 'FAIL')]),
      NotificationPriority.URGENT,
    );
  });

  test('cancelling an order is urgent', () => {
    assert.equal(
      derivePriority('Order', 'UPDATE', [f('cancelled', 'false', 'true')]),
      NotificationPriority.URGENT,
    );
  });

  test('granting super-admin rights is urgent, because it is', () => {
    assert.equal(
      derivePriority('User', 'UPDATE', [f('isSuperAdmin', 'false', 'true')]),
      NotificationPriority.URGENT,
    );
  });

  test('a marker note is low — not everything deserves an interruption', () => {
    assert.equal(
      derivePriority('Marker', 'CREATE', [f('fabricName', null, 'Rosetta')]),
      NotificationPriority.LOW,
    );
  });

  test('a batch takes the loudest of its parts, never the average', () => {
    // Three fields changed at once, one of which is a delivery date. The person
    // reading it needs to see the delivery date, so the whole batch is HIGH.
    const priority = derivePriority('Order', 'UPDATE', [
      f('orderName', 'Florida T', 'Florida T Shirt'),
      f('requiredDeliveryDate', '2026-09-03', '2026-09-05'),
      f('shippingMethod', 'Sea', 'Air'),
    ]);
    assert.equal(priority, NotificationPriority.HIGH);
  });

  test('deleting is never quieter than editing', () => {
    const edited = derivePriority('Attachment', 'UPDATE', [f('fileName', 'a.pdf', 'b.pdf')]);
    const deleted = derivePriority('Attachment', 'DELETE', [f('record', 'a.pdf', null)]);
    assert.equal(edited, NotificationPriority.LOW);
    assert.equal(deleted, NotificationPriority.HIGH);
  });

  test('highestPriority orders them the way a person would', () => {
    assert.equal(
      highestPriority([NotificationPriority.LOW, NotificationPriority.URGENT, NotificationPriority.NORMAL]),
      NotificationPriority.URGENT,
    );
    assert.equal(highestPriority([]), NotificationPriority.LOW);
  });
});

describe('one action reads as one sentence', () => {
  test('a single field says which field', () => {
    assert.equal(
      summariseChange({
        model: 'Order', action: 'UPDATE', subject: 'PO 13506',
        fields: [f('requiredDeliveryDate', '2026-09-03', '2026-09-05')],
      }),
      'Order PO 13506: required delivery date changed',
    );
  });

  test('two fields names both', () => {
    const s = summariseChange({
      model: 'Order', action: 'UPDATE', subject: 'PO 13506',
      fields: [f('qty', '300', '350'), f('requiredDeliveryDate', '2026-09-03', '2026-09-05')],
    });
    assert.match(s, /quantity and required delivery date changed/);
  });

  test('three or more is counted, because listing them all is unreadable', () => {
    const s = summariseChange({
      model: 'Order', action: 'UPDATE', subject: 'PO 13506',
      fields: [
        f('qty', '300', '350'),
        f('requiredDeliveryDate', '2026-09-03', '2026-09-05'),
        f('coordinatorId', 'a', 'b'),
      ],
    });
    assert.equal(s, 'Order PO 13506: 3 fields changed');
  });

  test('a create uses the model’s own verb', () => {
    assert.equal(
      summariseChange({ model: 'ProductionRecord', action: 'CREATE', subject: 'PO 13506', fields: [] }),
      'Production PO 13506 recorded',
    );
    assert.equal(
      summariseChange({ model: 'Attachment', action: 'CREATE', subject: 'artwork.pdf', fields: [] }),
      'Document artwork.pdf uploaded',
    );
  });

  test('a change with no subject still reads as a sentence', () => {
    assert.equal(
      summariseChange({ model: 'MaterialMovement', action: 'CREATE', subject: null, fields: [] }),
      'Stock movement recorded',
    );
  });
});

describe('before and after', () => {
  test('both known reads as an arrow', () => {
    assert.equal(
      describeFieldChange(f('qty', '300', '350')),
      'Quantity: 300 → 350',
    );
  });

  test('an unknown previous value is not invented', () => {
    // "was 0" would be a lie about what the field held.
    assert.equal(describeFieldChange(f('qty', null, '350')), 'Quantity set to 350');
  });

  test('a cleared field says what it used to be', () => {
    assert.match(describeFieldChange(f('qty', '350', null)), /cleared \(was 350\)/);
  });
});

describe('the catalogue is complete enough to use', () => {
  test('every tracked model has a category with a label', () => {
    for (const [model, def] of Object.entries(TRACKED_MODELS)) {
      assert.ok(def.label.length > 0, `${model} has no label`);
      assert.ok(
        CATEGORY_LABEL[def.category as ChangeCategory],
        `${model} is in category ${def.category}, which has no label`,
      );
    }
  });

  test('every model whose creation is the event says what verb to use', () => {
    for (const [model, def] of Object.entries(TRACKED_MODELS)) {
      if (!def.createIsAnEvent) continue;
      assert.ok(def.createdVerb, `${model}: creating one is the event but there is no verb for it`);
    }
  });

  test('every priority has a style, so nothing renders unlabelled', () => {
    for (const p of Object.values(NotificationPriority)) {
      assert.ok(PRIORITY_STYLE[p]?.label, `${p} has no style`);
    }
  });

  test('the things the factory asked to track are all present', () => {
    for (const model of [
      'Order', 'BomItem', 'ProductionRecord', 'MaterialMovement', 'MaterialReservation',
      'Task', 'QualityAudit', 'PackingList', 'Shipment', 'Approval', 'Attachment',
    ]) {
      assert.ok(TRACKED_MODELS[model], `${model} is not tracked`);
    }
  });
});

describe('a quantity change worth interrupting someone for', () => {
  test('a one-piece correction on a large order is routine, not news', () => {
    assert.equal(isSignificantQtyChange(1972, 1973), false);
  });

  test('a swing of a tenth or more is significant', () => {
    assert.equal(isSignificantQtyChange(1000, 1100), true);
    assert.equal(isSignificantQtyChange(1000, 900), true);
  });

  test('just under the threshold is not significant', () => {
    assert.equal(isSignificantQtyChange(1000, 1099), false);
  });

  test('no change at all is never significant', () => {
    assert.equal(isSignificantQtyChange(500, 500), false);
  });

  test('the first quantity ever entered is always significant — there is nothing to take a ratio of', () => {
    assert.equal(isSignificantQtyChange(0, 1), true);
    assert.equal(isSignificantQtyChange(0, 0), false);
  });
});
