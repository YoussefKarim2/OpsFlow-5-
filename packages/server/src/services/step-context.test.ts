/**
 * Step context assembly.
 *
 * `deriveOrderSteps` is tested against the workbook in @opsflow/shared. These
 * tests cover the layer underneath it: turning Prisma rows into the flat facts
 * the step definitions read. It is the layer where a wrong field name silently
 * makes a step say "Not started" forever, so every field that has ever been
 * misnamed is asserted by value here rather than by type alone.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { StageKey, StageStatus, StepState, deriveOrderSteps } from '@opsflow/shared';
import { buildStepContext, type StepOrderInput, type StepExtras } from './step-context.js';
import { sanitiseHtml } from '../util/sanitise-html.js';

const NO_EXTRAS: StepExtras = {
  referenceFileCount: 0,
  customInstructionCount: 0,
  hasProformaInvoice: false,
  proformaLineCount: 0,
  stockQty: 0,
  stockRecorded: false,
};

/** An order shaped like a Prisma row, with nothing recorded against it. */
function row(over: Partial<StepOrderInput> = {}): StepOrderInput {
  return {
    clientId: null, poNumber: null, orderName: null, styleNumber: null, itemType: null,
    requiredDeliveryDate: null, pricePerPieceUsd: null, fabric: null,
    externalWorkSort: null, externalWorkType: null,
    colors: [], sizes: [], quantities: [], markers: [], bomItems: [],
    externalOperations: [], productionRecords: [], qualityAudits: [],
    packingLists: [], shipments: [], costing: null, tasks: [], stages: [],
    ...over,
  };
}

describe('the step context reads the order the way the database stores it', () => {
  test('quantities are totalled by ledger, not counted', () => {
    const ctx = buildStepContext(row({
      quantities: [
        { ledger: 'ORDER', qty: 1000 }, { ledger: 'ORDER', qty: 972 },
        { ledger: 'CUT', qty: 2084 },
        { ledger: 'PACKED', qty: 40 },
      ],
    }), NO_EXTRAS);

    assert.equal(ctx.orderQty, 1972, 'the workbook total for PO 13506');
    assert.equal(ctx.cutQty, 2084);
    assert.equal(ctx.quantityCellCount, 2, 'only ORDER cells with a quantity count');
  });

  test('production, packing and shipping read the right columns', () => {
    // Each of these three was named something else in an earlier draft, and a
    // wrong name here is invisible: the step just never leaves "Not started".
    const ctx = buildStepContext(row({
      productionRecords: [{ qty: 600 }, { qty: 400 }],
      packingLists: [{ approved: true, cartons: [{ qty: 25 }, { qty: 25 }] }],
      shipments: [
        { qty: 900, status: 'SHIPPED', actualShippingDate: new Date('2026-09-01') },
        { qty: 500, status: 'READY', actualShippingDate: null },
      ],
    }), NO_EXTRAS);

    assert.equal(ctx.producedQty, 1000);
    assert.equal(ctx.productionRecordCount, 2);
    assert.equal(ctx.packedQty, 50);
    assert.equal(ctx.cartonCount, 2);
    assert.equal(ctx.packingApproved, true);
    assert.equal(ctx.shippedQty, 900, 'only shipments that actually went');
    assert.equal(ctx.shipmentBooked, true);
  });

  test('a shipment that has not left is not shipped quantity', () => {
    const ctx = buildStepContext(row({
      shipments: [{ qty: 1972, status: 'READY', actualShippingDate: null }],
    }), NO_EXTRAS);
    assert.equal(ctx.shippedQty, 0, 'a booked shipment is a plan, not a departure');
    assert.equal(ctx.shipmentBooked, true);
  });

  test('external work declared on the order counts before any operation exists', () => {
    const none = buildStepContext(row(), NO_EXTRAS);
    assert.equal(none.externalWorkDeclared, false);

    const declared = buildStepContext(row({ externalWorkSort: 'Print' }), NO_EXTRAS);
    assert.equal(declared.externalWorkDeclared, true,
      'otherwise the printing step looks inapplicable until it is already late');
  });

  test('the BOM is fully issued only when every line is', () => {
    const partial = buildStepContext(row({
      bomItems: [{ requiredQty: '1194', issuedQty: '1194' }, { requiredQty: '2000', issuedQty: '500' }],
    }), NO_EXTRAS);
    assert.equal(partial.bomFullyIssued, false);

    const full = buildStepContext(row({
      bomItems: [{ requiredQty: '1194', issuedQty: '1194' }, { requiredQty: '2000', issuedQty: '2000' }],
    }), NO_EXTRAS);
    assert.equal(full.bomFullyIssued, true);

    const empty = buildStepContext(row({ bomItems: [] }), NO_EXTRAS);
    assert.equal(empty.bomFullyIssued, false, 'an empty BOM is not a satisfied one');
  });

  test('the lay plan covers the requirement only when it produces enough', () => {
    const short = buildStepContext(row({ markers: [{}, {}] }), NO_EXTRAS, {
      materialShortCount: 0, markerPlannedQty: 1200, markerRequiredQty: 2084,
    });
    assert.equal(short.markerCount, 2);
    assert.equal(short.markerCoversRequirement, false, 'two markers are not a plan');

    const covered = buildStepContext(row({ markers: [{}] }), NO_EXTRAS, {
      materialShortCount: 0, markerPlannedQty: 2100, markerRequiredQty: 2084,
    });
    assert.equal(covered.markerCoversRequirement, true);
  });

  test('finished stock of zero is an answer, not a blank', () => {
    const checked = buildStepContext(row(), { ...NO_EXTRAS, stockRecorded: true, stockQty: 0 });
    assert.equal(checked.stockRecorded, true);
    assert.equal(checked.stockQty, 0);
  });

  test('a quality audit still pending is not a decided one', () => {
    const pending = buildStepContext(row({ qualityAudits: [{ result: 'PENDING' }] }), NO_EXTRAS);
    assert.equal(pending.auditCount, 0);
    assert.equal(pending.auditPassed, false);

    const failed = buildStepContext(row({ qualityAudits: [{ result: 'FAIL' }] }), NO_EXTRAS);
    assert.equal(failed.auditCount, 1);
    assert.equal(failed.openQualityFailure, true);
    assert.equal(failed.auditPassed, false);
  });

  test('tasks are counted per step, and an overdue one is not a completed one', () => {
    const today = new Date('2026-08-24');
    const ctx = buildStepContext(row({
      tasks: [
        { stageKey: 'PROGRESS_STATUS', status: 'COMPLETED', dueDate: new Date('2026-08-01') },
        { stageKey: 'PROGRESS_STATUS', status: 'NOT_STARTED', dueDate: new Date('2026-08-01') },
        { stageKey: 'PROGRESS_STATUS', status: 'NOT_STARTED', dueDate: new Date('2026-12-01') },
      ],
    }), NO_EXTRAS, undefined, today);

    assert.deepEqual(ctx.taskCounts[StageKey.PROGRESS_STATUS], { total: 3, completed: 1, overdue: 1 });
  });

  test('a stage override reaches the derivation intact', () => {
    const ctx = buildStepContext(row({
      stages: [{
        stageKey: 'EXTERNAL_ORDER',
        statusOverride: StageStatus.NOT_REQUIRED,
        notRequiredReason: 'Plain garment, no print',
        startedAt: null, completedAt: null, notes: null,
      }],
    }), NO_EXTRAS);

    const step = deriveOrderSteps(ctx).steps.find((s) => s.key === StageKey.EXTERNAL_ORDER)!;
    assert.equal(step.state, StepState.NOT_REQUIRED);
    assert.equal(step.notRequiredReason, 'Plain garment, no print');
  });

  test('a stage row for something that is not a step is ignored, not crashed on', () => {
    const ctx = buildStepContext(row({
      stages: [{
        stageKey: 'SOMETHING_REMOVED_IN_A_LATER_VERSION',
        statusOverride: null, notRequiredReason: null,
        startedAt: null, completedAt: null, notes: null,
      }],
    }), NO_EXTRAS);
    assert.equal(Object.keys(ctx.overrides).length, 0);
  });
});

describe('the whole workbook order, end to end through the context', () => {
  // PO 13506 as the workbook has it: details and quantities in, nothing made.
  const po13506 = row({
    clientId: 'c1', poNumber: '13506', orderName: 'Florida T Shirt',
    styleNumber: 'FL-2026', itemType: 'T-Shirt',
    requiredDeliveryDate: new Date('2026-11-15'), pricePerPieceUsd: 7.25,
    fabric: 'Rosetta Jersey',
    colors: [{}, {}, {}, {}], sizes: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}],
    quantities: [{ ledger: 'ORDER', qty: 1972 }, { ledger: 'CUT', qty: 2084 }],
  });

  test('the coordinator is sent to the proforma invoice, not left guessing', () => {
    const ctx = buildStepContext(po13506, { ...NO_EXTRAS, referenceFileCount: 1 });
    const r = deriveOrderSteps(ctx);

    // Steps 1–3 are done from the import; step 4 is the first thing owed.
    assert.equal(r.steps.find((s) => s.key === StageKey.ORDER_DETAILS)!.state, StepState.COMPLETED);
    assert.equal(r.steps.find((s) => s.key === StageKey.MAIN_ORDER)!.state, StepState.COMPLETED);
    assert.equal(r.current?.key, StageKey.PROFORMA_INVOICE);
    assert.ok(r.current?.missing, 'the current step must say what it wants');
  });

  test('progress never counts a step the order does not need', () => {
    const ctx = buildStepContext(po13506, { ...NO_EXTRAS, referenceFileCount: 1 });
    const r = deriveOrderSteps(ctx);
    assert.ok(r.applicableCount < 18, 'this order has no external work');
    assert.ok(r.percentComplete > 0 && r.percentComplete < 100);
  });
});

describe('instruction text cannot carry script to the next person who reads it', () => {
  test('script, style and event handlers are removed', () => {
    assert.equal(sanitiseHtml('<script>steal()</script>Cut on the fold'), 'Cut on the fold');
    assert.equal(sanitiseHtml('<img src=x onerror="steal()">'), '');
    assert.equal(sanitiseHtml('<a href="javascript:steal()">click</a>'), 'click');
    assert.equal(sanitiseHtml('<iframe src="//evil"></iframe>ok'), 'ok');
  });

  test('the formatting a coordinator actually uses survives', () => {
    assert.equal(
      sanitiseHtml('<p><strong>Do not</strong> start printing before approval.</p>'),
      '<p><strong>Do not</strong> start printing before approval.</p>',
    );
    assert.equal(sanitiseHtml('<ul><li>Wash cold</li></ul>'), '<ul><li>Wash cold</li></ul>');
  });

  test('attributes are dropped even on allowed tags', () => {
    assert.equal(sanitiseHtml('<p onclick="steal()" style="x">hi</p>'), '<p>hi</p>');
  });
});
