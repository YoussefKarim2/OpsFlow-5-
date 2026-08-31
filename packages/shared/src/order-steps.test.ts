/**
 * Order-step tests.
 *
 * These assert the behaviour the factory's own workbook implies, and the
 * behaviour a beginner depends on: exactly one current step, "not required"
 * treated as an answer rather than an omission, and a person's decision always
 * beating the system's guess.
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { StageKey, StageStatus, STAGE_META } from './enums.js';
import {
  ORDER_STEPS, ORDER_TAB_KEYS, STEP_BY_KEY, StepState, deriveOrderSteps, type StepContext,
} from './order-steps.js';

/** An order at the very beginning — nothing entered but the import. */
function fresh(over: Partial<StepContext> = {}): StepContext {
  return {
    referenceFileCount: 0,
    hasClient: false, hasPoNumber: false, hasOrderName: false, hasStyleNumber: false,
    hasItemType: false, hasRequiredDate: false, hasPrice: false, hasFabric: false,
    orderQty: 0, quantityCellCount: 0, colorCount: 0, sizeCount: 0,
    cutQty: 0, stockQty: 0, stockRecorded: false,
    markerCount: 0, markerCoversRequirement: false,
    bomLineCount: 0, bomFullyIssued: false, materialShortCount: 0,
    customInstructionCount: 0,
    externalWorkDeclared: false, externalOpCount: 0, externalOpsReturned: 0, externalOpsBlocked: 0,
    producedQty: 0, productionRecordCount: 0,
    auditCount: 0, auditPassed: false, openQualityFailure: false,
    cartonCount: 0, packedQty: 0, packingApproved: false,
    hasCosting: false, costLineCount: 0,
    hasProformaInvoice: false, proformaLineCount: 0,
    shippedQty: 0, shipmentBooked: false,
    taskCounts: {},
    overrides: {},
    ...over,
  };
}

/** The seeded order: details and quantities in, nothing made yet. */
function started(over: Partial<StepContext> = {}): StepContext {
  return fresh({
    referenceFileCount: 2,
    hasClient: true, hasPoNumber: true, hasOrderName: true, hasStyleNumber: true,
    hasItemType: true, hasRequiredDate: true, hasPrice: true, hasFabric: true,
    orderQty: 1972, quantityCellCount: 40, colorCount: 4, sizeCount: 10,
    cutQty: 2084,
    ...over,
  });
}

const stateOf = (r: ReturnType<typeof deriveOrderSteps>, key: StageKey) =>
  r.steps.find((s) => s.key === key)!.state;

describe('a reference page is not a task', () => {
  test('the Database step never becomes the current step', () => {
    // It sits at 17, between Actual Costing and Invoice. If it counted as work
    // it would stop a coordinator between the two and ask them to do nothing.
    const r = deriveOrderSteps(fresh());
    for (const s of r.steps) {
      if (s.key === StageKey.DATABASE) assert.equal(s.isCurrent, false);
    }
    assert.notEqual(r.current?.key, StageKey.DATABASE);
  });

  test('it is left out of the progress denominator', () => {
    const r = deriveOrderSteps(fresh());
    // Eighteen steps, less Database (reference) and less External Order (this
    // order has no printing), leaves sixteen pieces of actual work.
    assert.equal(r.steps.length, 18);
    assert.equal(r.applicableCount, 16);

    // Declaring external work adds one back; Database never comes back.
    const withPrinting = deriveOrderSteps(fresh({ externalWorkDeclared: true }));
    assert.equal(withPrinting.applicableCount, 17);
  });

  test('opening it cannot move an order’s progress', () => {
    assert.equal(STAGE_META[StageKey.DATABASE].weight, 0);
  });
});

describe('the step list matches the workbook', () => {
  test('the workbook’s eighteen steps, in its own order', () => {
    assert.equal(ORDER_STEPS.length, 18);
    assert.deepEqual(
      ORDER_STEPS.map((s) => s.order),
      Array.from({ length: 18 }, (_, i) => i + 1),
      'step numbers must run 1..18 with no gaps or repeats',
    );
  });

  test('the sequence is the workbook’s hyperlink menu', () => {
    // Cells A4:A21 of every sheet, in order. This is the factory's SOP, and it
    // is transcribed from the file rather than from memory — the first version
    // of this test asserted a transcription that had Production and Audit two
    // places too early and replaced the workbook's Database sheet with an
    // invented "Complete" step. A test that agrees with the code it is testing
    // is not a test.
    assert.deepEqual(ORDER_STEPS.map((s) => s.key), [
      StageKey.CUSTOMER_ORDER_REF,   // A4
      StageKey.ORDER_DETAILS,        // A5
      StageKey.MAIN_ORDER,           // A6
      StageKey.PROFORMA_INVOICE,     // A7
      StageKey.EXTERNAL_ORDER,       // A8
      StageKey.PROGRESS_STATUS,      // A9
      StageKey.CUT_ORDER,            // A10
      StageKey.LAYING_FABRIC,        // A11
      StageKey.BILL_OF_MATERIAL,     // A12
      StageKey.CUSTOM_INSTRUCTIONS,  // A13
      StageKey.PACKING,              // A14
      StageKey.STOCK,                // A15
      StageKey.FOLLOW_UP,            // A16
      StageKey.PRODUCTION_FOLLOW_UP, // A17
      StageKey.AUDIT,                // A18
      StageKey.ACTUAL_COSTING,       // A19
      StageKey.DATABASE,             // A20
      StageKey.INVOICE,              // A21
    ]);
  });

  test('every one of the eighteen names the sheet it came from', () => {
    // The sheet name is how somebody checks a step against the workbook.
    for (const s of ORDER_STEPS) {
      assert.ok(s.sheetName.length > 1, `${s.key} does not name its sheet`);
    }
  });

  test('STAGE_META agrees with the step order, so the two cannot drift', () => {
    for (const step of ORDER_STEPS) {
      assert.equal(
        STAGE_META[step.key].order, step.order,
        `${step.key}: STAGE_META says ${STAGE_META[step.key].order}, the step list says ${step.order}`,
      );
    }
  });

  test('progress weights still sum to 100', () => {
    const total = Object.values(STAGE_META).reduce((a, m) => a + m.weight, 0);
    assert.equal(total, 100);
  });

  test('every step says who does it and what to enter', () => {
    for (const s of ORDER_STEPS) {
      assert.ok(s.label.length > 0, `${s.key} has no label`);
      assert.ok(s.purpose.length > 0, `${s.key} has no purpose`);
      assert.ok(s.department, `${s.key} has no department`);
      assert.ok(s.whatYouEnter.length > 0, `${s.key} does not say what to enter`);
      assert.ok(s.tab.length > 0, `${s.key} has nowhere to go`);
    }
  });

  test('every step points at a screen that exists', () => {
    // A step whose tab is not a real screen navigates to a blank page, and does
    // so silently — a string is a string. The proforma step did exactly that.
    for (const s of ORDER_STEPS) {
      assert.ok(
        (ORDER_TAB_KEYS as readonly string[]).includes(s.tab),
        `${s.key} opens "${s.tab}", which is not a screen the workspace renders`,
      );
    }
  });

  test('every step is reachable by key', () => {
    for (const s of ORDER_STEPS) assert.equal(STEP_BY_KEY[s.key]?.order, s.order);
  });
});

describe('a brand-new order', () => {
  test('the first step is the customer reference, and only that one is current', () => {
    const r = deriveOrderSteps(fresh());
    assert.equal(r.current?.key, StageKey.CUSTOMER_ORDER_REF);
    assert.equal(r.steps.filter((s) => s.isCurrent).length, 1, 'exactly one step may be current');
  });

  test('the next step is named, so the coordinator knows what is coming', () => {
    const r = deriveOrderSteps(fresh());
    assert.equal(r.next?.key, StageKey.ORDER_DETAILS);
  });

  test('every outstanding step says what is missing', () => {
    const r = deriveOrderSteps(fresh());
    const outstanding = r.steps.filter(
      (s) => s.state !== StepState.COMPLETED && s.state !== StepState.NOT_REQUIRED,
    );
    // An informational step (Database) is a reference page, not a task, so it
    // has nothing to ask for.
    for (const s of outstanding.filter((x) => !x.informational)) {
      assert.ok(s.missing, `${s.key} is outstanding but does not say what is needed`);
    }
  });

  test('progress is zero and nothing is claimed as done', () => {
    const r = deriveOrderSteps(fresh());
    assert.equal(r.percentComplete, 0);
    assert.equal(r.completedCount, 0);
  });
});

describe('steps complete themselves from the data', () => {
  test('attaching the customer document completes step 1', () => {
    assert.equal(stateOf(deriveOrderSteps(fresh()), StageKey.CUSTOMER_ORDER_REF), StepState.NOT_STARTED);
    assert.equal(
      stateOf(deriveOrderSteps(fresh({ referenceFileCount: 1 })), StageKey.CUSTOMER_ORDER_REF),
      StepState.COMPLETED,
    );
  });

  test('the order details step needs the facts the workbook needs', () => {
    const r = deriveOrderSteps(started());
    assert.equal(stateOf(r, StageKey.ORDER_DETAILS), StepState.COMPLETED);

    // Everything but the customer is in, so the step is part-done — not
    // untouched. Calling it "Not started" would tell the coordinator to
    // re-enter six fields that are already there.
    const missingClient = deriveOrderSteps(started({ hasClient: false }));
    assert.equal(stateOf(missingClient, StageKey.ORDER_DETAILS), StepState.IN_PROGRESS);
    assert.match(
      missingClient.steps.find((s) => s.key === StageKey.ORDER_DETAILS)!.missing!,
      /customer/,
    );

    // Nothing entered at all is the only thing that reads as "Not started".
    assert.equal(stateOf(deriveOrderSteps(fresh()), StageKey.ORDER_DETAILS), StepState.NOT_STARTED);
  });

  test('the cut order completes on its own — it is calculated, never typed', () => {
    const r = deriveOrderSteps(started());
    assert.equal(stateOf(r, StageKey.CUT_ORDER), StepState.COMPLETED);
    const noQty = deriveOrderSteps(started({ cutQty: 0 }));
    assert.match(noQty.steps.find((s) => s.key === StageKey.CUT_ORDER)!.missing!, /calculated/);
  });

  test('production completes only when the whole order is made', () => {
    const half = deriveOrderSteps(started({ producedQty: 1000, productionRecordCount: 5 }));
    assert.equal(stateOf(half, StageKey.PRODUCTION_FOLLOW_UP), StepState.IN_PROGRESS);
    assert.match(
      half.steps.find((s) => s.key === StageKey.PRODUCTION_FOLLOW_UP)!.missing!,
      /972 pieces still to produce/,
    );

    const all = deriveOrderSteps(started({ producedQty: 1972, productionRecordCount: 9 }));
    assert.equal(stateOf(all, StageKey.PRODUCTION_FOLLOW_UP), StepState.COMPLETED);
  });

  test('a failed inspection keeps the quality step open', () => {
    const failed = deriveOrderSteps(started({ auditCount: 1, auditPassed: false, openQualityFailure: true }));
    assert.equal(stateOf(failed, StageKey.AUDIT), StepState.IN_PROGRESS);
    assert.match(failed.steps.find((s) => s.key === StageKey.AUDIT)!.missing!, /corrective action/);
  });

  test('packing needs both cartons and the coordinator’s approval', () => {
    const cartons = deriveOrderSteps(started({ cartonCount: 25, packingApproved: false }));
    assert.equal(stateOf(cartons, StageKey.PACKING), StepState.IN_PROGRESS);
    assert.match(cartons.steps.find((s) => s.key === StageKey.PACKING)!.missing!, /not been approved/);

    const approved = deriveOrderSteps(started({ cartonCount: 25, packingApproved: true }));
    assert.equal(stateOf(approved, StageKey.PACKING), StepState.COMPLETED);
  });
});

describe('“not required” is an answer, not an omission', () => {
  test('an order with no external work skips that step automatically', () => {
    const r = deriveOrderSteps(started());
    assert.equal(stateOf(r, StageKey.EXTERNAL_ORDER), StepState.NOT_REQUIRED);
    const step = r.steps.find((s) => s.key === StageKey.EXTERNAL_ORDER)!;
    assert.match(step.notRequiredReason!, /no printing or embroidery/i);
    assert.equal(step.missing, null, 'a step that does not apply must not ask for anything');
  });

  test('an order that declares printing does need the step', () => {
    const r = deriveOrderSteps(started({ externalWorkDeclared: true }));
    assert.equal(stateOf(r, StageKey.EXTERNAL_ORDER), StepState.NOT_STARTED);
  });

  test('recorded operations bring the step back even without a declaration', () => {
    const r = deriveOrderSteps(started({ externalOpCount: 4, externalOpsReturned: 0 }));
    assert.notEqual(stateOf(r, StageKey.EXTERNAL_ORDER), StepState.NOT_REQUIRED);
  });

  test('a person can mark any step not required, with a reason', () => {
    const r = deriveOrderSteps(started({
      overrides: {
        [StageKey.CUSTOM_INSTRUCTIONS]: {
          status: 'NOT_REQUIRED', completedAt: null, startedAt: null,
          notRequiredReason: 'Nothing special about this order', notes: null,
        },
      },
    }));
    const step = r.steps.find((s) => s.key === StageKey.CUSTOM_INSTRUCTIONS)!;
    assert.equal(step.state, StepState.NOT_REQUIRED);
    assert.equal(step.notRequiredReason, 'Nothing special about this order');
  });

  test('steps that do not apply are left out of the progress calculation', () => {
    // Otherwise an order with no printing could never reach 100%.
    const withExternal = deriveOrderSteps(started({ externalWorkDeclared: true }));
    const without = deriveOrderSteps(started());
    assert.ok(
      without.applicableCount < withExternal.applicableCount,
      'a not-required step should not count toward the total',
    );
  });
});

describe('a person’s decision beats the system’s guess', () => {
  test('marking a step complete completes it even when the data disagrees', () => {
    // The system can see there are no cartons. Only the supervisor knows the
    // packing was done on paper during the outage.
    const r = deriveOrderSteps(started({
      overrides: {
        [StageKey.PACKING]: {
          status: StageStatus.COMPLETED, completedAt: '2026-09-01T10:00:00Z',
          startedAt: null, notRequiredReason: null, notes: 'Packed against the paper list',
        },
      },
    }));
    const step = r.steps.find((s) => s.key === StageKey.PACKING)!;
    assert.equal(step.state, StepState.COMPLETED);
    assert.equal(step.notes, 'Packed against the paper list');
    assert.ok(step.completedAt);
  });

  test('a step can be set to waiting, which the data could never infer', () => {
    const r = deriveOrderSteps(started({
      overrides: {
        [StageKey.BILL_OF_MATERIAL]: {
          status: StageStatus.WAITING, completedAt: null, startedAt: null,
          notRequiredReason: null, notes: 'Supplier confirming delivery date',
        },
      },
    }));
    assert.equal(stateOf(r, StageKey.BILL_OF_MATERIAL), StepState.WAITING);
  });

  test('a blocked step is still the current step', () => {
    // Hiding a blockage behind the next unblocked step is how it goes unattended.
    // Everything before the BOM is signed off, so the BOM is where the order
    // stands; blocking it must not hand "current" to step ten.
    const done = STEP_BY_KEY[StageKey.BILL_OF_MATERIAL]!.order;
    const overrides = Object.fromEntries(
      ORDER_STEPS.filter((s) => s.order < done).map((s) => [
        s.key,
        {
          status: StageStatus.COMPLETED,
          completedAt: new Date('2026-08-01'),
          startedAt: new Date('2026-07-01'),
          notRequiredReason: null,
          notes: null,
        },
      ]),
    );
    const r = deriveOrderSteps(
      started({ referenceFileCount: 1, overrides }),
      new Set([StageKey.BILL_OF_MATERIAL]),
    );
    assert.equal(stateOf(r, StageKey.BILL_OF_MATERIAL), StepState.BLOCKED);
    assert.equal(r.current?.key, StageKey.BILL_OF_MATERIAL);
  });
});

describe('steps that need a person to say so', () => {
  test('special instructions are never auto-completed', () => {
    // "No special instructions" is a decision somebody makes, not an absence.
    const r = deriveOrderSteps(started({ customInstructionCount: 3 }));
    assert.equal(stateOf(r, StageKey.CUSTOM_INSTRUCTIONS), StepState.IN_PROGRESS);
    assert.ok(r.steps.find((s) => s.key === StageKey.CUSTOM_INSTRUCTIONS)!.manualCompletion);
  });

  test('finished stock is never auto-completed either', () => {
    const r = deriveOrderSteps(started({ stockRecorded: true }));
    assert.equal(stateOf(r, StageKey.STOCK), StepState.IN_PROGRESS);
  });

  test('but a person completing them sticks', () => {
    const r = deriveOrderSteps(started({
      customInstructionCount: 0,
      overrides: {
        [StageKey.CUSTOM_INSTRUCTIONS]: {
          status: StageStatus.COMPLETED, completedAt: '2026-08-20T09:00:00Z',
          startedAt: null, notRequiredReason: null, notes: null,
        },
      },
    }));
    assert.equal(stateOf(r, StageKey.CUSTOM_INSTRUCTIONS), StepState.COMPLETED);
  });
});

describe('progress across the whole order', () => {
  test('a finished order reaches every step', () => {
    const done = started({
      referenceFileCount: 3,
      externalWorkDeclared: true, externalOpCount: 4, externalOpsReturned: 4,
      hasProformaInvoice: true, proformaLineCount: 4,
      markerCount: 6, markerCoversRequirement: true,
      bomLineCount: 23, bomFullyIssued: true,
      customInstructionCount: 2,
      producedQty: 1972, productionRecordCount: 12,
      auditCount: 1, auditPassed: true,
      cartonCount: 25, packedQty: 1972, packingApproved: true,
      stockRecorded: true,
      hasCosting: true, costLineCount: 12,
      shippedQty: 1972, shipmentBooked: true,
      taskCounts: { [StageKey.PROGRESS_STATUS]: { total: 27, completed: 27, overdue: 0 } },
      overrides: {
        // The two steps that need a person.
        [StageKey.CUSTOM_INSTRUCTIONS]: { status: StageStatus.COMPLETED, completedAt: '2026-09-01', startedAt: null, notRequiredReason: null, notes: null },
        [StageKey.STOCK]: { status: StageStatus.COMPLETED, completedAt: '2026-09-01', startedAt: null, notRequiredReason: null, notes: null },
      },
    });

    const r = deriveOrderSteps(done);
    const unfinished = r.steps.filter(
      (s) => !s.informational
        && s.state !== StepState.COMPLETED
        && s.state !== StepState.NOT_REQUIRED,
    );
    assert.deepEqual(unfinished.map((s) => s.key), [], 'every step should be finished');
    assert.equal(r.percentComplete, 100);
    assert.equal(r.current, null, 'a finished order has no current step');

    // The Database step is reference, not work: it is neither finished nor
    // holding the order up, and it never became the current step on the way.
    const database = r.steps.find((s) => s.key === StageKey.DATABASE)!;
    assert.equal(database.informational, true);
    assert.equal(database.isCurrent, false);
  });

  test('progress counts steps, not guesses', () => {
    const r = deriveOrderSteps(started({ referenceFileCount: 1 }));
    // Reference, details, main order and cut order are done; the rest are not.
    assert.equal(r.completedCount, 4);
    assert.ok(r.percentComplete > 0 && r.percentComplete < 100);
  });
});
