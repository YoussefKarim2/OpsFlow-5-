/**
 * Stage-gate tests.
 *
 * These assert the behaviour the brief asks for in §16: a stage that cannot
 * start says so, says what is missing, and says where to go and fix it.
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { StageKey } from '../enums.js';
import {
  STAGE_GATES, evaluateStageGates, evaluateAllGates, type GateContext,
} from './workflow-gates.js';

/** An order with nothing wrong with it. Each test breaks one thing. */
function healthy(over: Partial<GateContext> = {}): GateContext {
  return {
    orderQty: 1972,
    cutQty: 2084,
    producedQty: 1250,
    packedQty: 0,
    quantityCellCount: 24,
    hasBom: true,
    bomFullyIssued: true,
    materialsFullyCoverable: true,
    materialShortageCount: 0,
    materialShortageDetail: null,
    hasMarkers: true,
    markerCoversRequirement: true,
    markerShortfall: 0,
    hasPendingBlockingApproval: false,
    pendingApprovalLabel: null,
    externalOpsBlocked: 0,
    hasOpenQualityFailure: false,
    qualityInspected: true,
    packingApproved: true,
    hasCartons: true,
    completedStages: new Set<StageKey>(),
    ...over,
  };
}

const cutting = (ctx: GateContext) => evaluateStageGates(StageKey.FOLLOW_UP, ctx, 'Cutting');

describe('the cutting gate', () => {
  test('a healthy order can start cutting', () => {
    const r = cutting(healthy());
    assert.equal(r.canStart, true);
    assert.deepEqual(r.blockers, []);
  });

  test('a fabric shortage blocks it, and says by how much', () => {
    const r = cutting(healthy({
      materialShortageCount: 1,
      materialShortageDetail: 'Cotton Jersey is short by 476 M.',
    }));
    assert.equal(r.canStart, false);
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0]!.detail, /476/);
    assert.equal(r.blockers[0]!.tab, 'materials');
    assert.ok(r.blockers[0]!.actionLabel);
  });

  test('a missing marker blocks it', () => {
    const r = cutting(healthy({ hasMarkers: false, markerCoversRequirement: false }));
    assert.equal(r.canStart, false);
    assert.match(r.blockers[0]!.detail, /no lay plan/i);
  });

  test('a marker that is short of the requirement blocks it, with the shortfall', () => {
    const r = cutting(healthy({ markerCoversRequirement: false, markerShortfall: -120 }));
    assert.equal(r.canStart, false);
    assert.match(r.blockers[0]!.detail, /120/);
  });

  test('a pending customer approval blocks it', () => {
    const r = cutting(healthy({
      hasPendingBlockingApproval: true,
      pendingApprovalLabel: 'Print artwork approval',
    }));
    assert.equal(r.canStart, false);
    assert.match(r.blockers[0]!.detail, /Print artwork approval/);
  });

  test('several problems are reported together, not one at a time', () => {
    // Fixing one thing only to be told about the next is how a coordinator
    // loses a day.
    const r = cutting(healthy({
      materialShortageCount: 2,
      hasMarkers: false,
      markerCoversRequirement: false,
      hasPendingBlockingApproval: true,
    }));
    assert.equal(r.blockers.length, 3);
  });

  test('unissued material is a warning, not a blocker', () => {
    // The fabric exists and is reserved; issuing it is a warehouse errand, not
    // a reason the cutting room cannot plan.
    const r = cutting(healthy({ bomFullyIssued: false }));
    assert.equal(r.canStart, true);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.blockers.length, 0);
  });

  test('every requirement is reported, met or not, so the list is a checklist', () => {
    const r = cutting(healthy());
    assert.equal(r.requirements.length, STAGE_GATES[StageKey.FOLLOW_UP]!.length);
    assert.ok(r.requirements.every((x) => x.met));
    assert.ok(r.requirements.every((x) => x.label.length > 0));
  });
});

describe('other gated stages', () => {
  test('cutting cannot be planned before quantities are entered', () => {
    const r = evaluateStageGates(StageKey.CUT_ORDER, healthy({ quantityCellCount: 0, orderQty: 0 }), 'Cut order');
    assert.equal(r.canStart, false);
    assert.match(r.blockers[0]!.detail, /matrix is empty/i);
  });

  test('production is blocked by an open quality failure', () => {
    const r = evaluateStageGates(StageKey.PRODUCTION_FOLLOW_UP, healthy({ hasOpenQualityFailure: true }), 'Production');
    assert.equal(r.canStart, false);
    assert.match(r.blockers[0]!.detail, /corrective action/i);
  });

  test('packing is blocked until an inspection has been recorded', () => {
    const r = evaluateStageGates(StageKey.PACKING, healthy({ qualityInspected: false }), 'Packing');
    assert.equal(r.canStart, false);
    assert.match(r.blockers[0]!.detail, /no final inspection/i);
  });

  test('shipping is blocked until the packing list is approved', () => {
    const r = evaluateStageGates(StageKey.INVOICE, healthy({ packingApproved: false }), 'Invoice');
    assert.equal(r.canStart, false);
    assert.match(r.blockers[0]!.detail, /not been approved/i);
  });

  test('an external operation awaiting approval blocks release', () => {
    const r = evaluateStageGates(StageKey.EXTERNAL_ORDER, healthy({ externalOpsBlocked: 4 }), 'External');
    assert.equal(r.canStart, false);
    assert.match(r.blockers[0]!.detail, /4 external operations/);
  });

  test('an ungated stage is never blocked', () => {
    const r = evaluateStageGates(StageKey.CUSTOM_INSTRUCTIONS, healthy({ hasBom: false }), 'Instructions');
    assert.equal(r.canStart, true);
    assert.deepEqual(r.requirements, []);
  });
});

describe('whole-order evaluation', () => {
  test('a healthy order reports no blockers anywhere', () => {
    const r = evaluateAllGates(healthy(), {});
    assert.deepEqual(r.blockers, []);
    assert.ok(r.readyStages.length > 0);
  });

  test('blockers are found in stages that have not been reached yet', () => {
    // The point: a shortage that will block cutting in three days should be
    // visible today, not on the morning the fabric is needed.
    const r = evaluateAllGates(
      healthy({ materialShortageCount: 1, materialShortageDetail: 'Short by 476 M.' }),
      {},
    );
    assert.equal(r.blockers.length, 1);
    assert.equal(r.blockers[0]!.stageKey, StageKey.FOLLOW_UP);
  });

  test('a completed stage’s gates are history and are not reported', () => {
    // Otherwise the coordinator is told that finished work is blocked.
    const ctx = healthy({
      materialShortageCount: 1,
      materialShortageDetail: 'Short by 476 M.',
      completedStages: new Set([StageKey.FOLLOW_UP]),
    });
    const r = evaluateAllGates(ctx, {});
    assert.deepEqual(r.blockers, []);
    assert.ok(!r.readyStages.includes(StageKey.FOLLOW_UP));
  });

  test('each blocker carries the stage it belongs to, for grouping', () => {
    const r = evaluateAllGates(
      healthy({ hasOpenQualityFailure: true, qualityInspected: false }),
      { [StageKey.PRODUCTION_FOLLOW_UP]: 'Production', [StageKey.PACKING]: 'Packing' },
    );
    const stages = new Set(r.blockers.map((b) => b.stageKey));
    assert.ok(stages.has(StageKey.PRODUCTION_FOLLOW_UP));
    assert.ok(stages.has(StageKey.PACKING));
    assert.equal(
      r.blockers.find((b) => b.stageKey === StageKey.PRODUCTION_FOLLOW_UP)!.stageLabel,
      'Production',
    );
  });

  test('every blocker tells the coordinator where to go', () => {
    const r = evaluateAllGates(
      healthy({
        materialShortageCount: 1,
        hasMarkers: false,
        markerCoversRequirement: false,
        hasOpenQualityFailure: true,
        qualityInspected: false,
        packingApproved: false,
        hasCartons: false,
      }),
      {},
    );
    assert.ok(r.blockers.length >= 4);
    for (const b of r.blockers) {
      assert.ok(b.detail.length > 0, `${b.key} has no explanation`);
      assert.ok(b.tab, `${b.key} has nowhere to go`);
      assert.ok(b.actionLabel, `${b.key} has no action`);
    }
  });
});
