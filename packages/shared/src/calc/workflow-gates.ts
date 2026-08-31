/**
 * Stage gates — what a stage needs before it can start, and what is missing.
 *
 * The brief's §16: *Cutting requires BOM approved, fabric available, marker
 * completed, quantity confirmed. If something is missing, say so.*
 *
 * Two design choices worth stating.
 *
 * **Blockers are derived, never stored.** There is no `WorkflowBlocker` table.
 * A stored blocker is one that can be wrong — the fabric arrives, the row stays,
 * and the coordinator is chasing a shortage that was resolved on Tuesday. Every
 * blocker on the screen is recomputed from the order's current state on the
 * request that renders it, exactly like status and progress already are.
 *
 * **Requirements are declarative.** Each gate is a row in the table below with
 * a predicate over one context object, so the rules can be read in one screen
 * and a new one is a row, not a code path. That matters because these rules are
 * the factory's process, and the factory will want to change them.
 */

import { StageKey } from '../enums.js';

/** Everything a gate may examine. Assembled once per order, on the server. */
export interface GateContext {
  orderQty: number;
  cutQty: number;
  producedQty: number;
  packedQty: number;
  /** Colour × size cells with a quantity — the matrix is entered. */
  quantityCellCount: number;
  hasBom: boolean;
  bomFullyIssued: boolean;
  /** From the inventory engine: nothing outstanding is un-securable. */
  materialsFullyCoverable: boolean;
  materialShortageCount: number;
  materialShortageDetail: string | null;
  hasMarkers: boolean;
  markerCoversRequirement: boolean;
  markerShortfall: number;
  hasPendingBlockingApproval: boolean;
  pendingApprovalLabel: string | null;
  externalOpsBlocked: number;
  hasOpenQualityFailure: boolean;
  qualityInspected: boolean;
  packingApproved: boolean;
  hasCartons: boolean;
  /** Stage keys whose tasks are all complete. */
  completedStages: ReadonlySet<StageKey>;
}

export interface GateRequirement {
  key: string;
  /** What the coordinator must have. Phrased as the goal, not the failure. */
  label: string;
  /** True when satisfied. */
  test: (c: GateContext) => boolean;
  /** Why it is not satisfied — written for the person who has to fix it. */
  explain: (c: GateContext) => string;
  /** What to do about it, and where. */
  action?: (c: GateContext) => { label: string; tab: string } | null;
  /** A blocker stops the stage; a warning lets it proceed with a caveat. */
  severity: 'BLOCKER' | 'WARNING';
}

/**
 * The gate table.
 *
 * Only stages with genuine prerequisites appear. A stage with no entry is
 * ungated — which is the honest default, and better than inventing a rule the
 * factory does not actually follow.
 */
export const STAGE_GATES: Partial<Record<StageKey, GateRequirement[]>> = {
  [StageKey.CUT_ORDER]: [
    {
      key: 'quantities-entered',
      label: 'Order quantities confirmed',
      severity: 'BLOCKER',
      test: (c) => c.quantityCellCount > 0 && c.orderQty > 0,
      explain: () => 'The colour × size matrix is empty, so there is nothing to cut.',
      action: () => ({ label: 'Enter quantities', tab: 'quantity' }),
    },
    {
      key: 'bom-exists',
      label: 'Bill of materials created',
      severity: 'BLOCKER',
      test: (c) => c.hasBom,
      explain: () => 'No bill of materials has been created, so material requirements are unknown.',
      action: () => ({ label: 'Build the BOM', tab: 'bom' }),
    },
  ],

  [StageKey.LAYING_FABRIC]: [
    {
      key: 'cut-quantity',
      label: 'Cut quantity calculated',
      severity: 'BLOCKER',
      test: (c) => c.cutQty > 0,
      explain: () => 'The cut order has not been generated, so the lay plan has no target.',
      action: () => ({ label: 'Generate the cut order', tab: 'quantity' }),
    },
  ],

  [StageKey.BILL_OF_MATERIAL]: [
    {
      key: 'bom-lines',
      label: 'Materials listed',
      severity: 'BLOCKER',
      test: (c) => c.hasBom,
      explain: () => 'The bill of materials is empty.',
      action: () => ({ label: 'Add materials', tab: 'bom' }),
    },
  ],

  // The stage the brief calls out by name. Everything the cutting floor needs
  // in place before a blade touches fabric.
  [StageKey.FOLLOW_UP]: [
    {
      key: 'materials-available',
      label: 'Fabric and trims available',
      severity: 'BLOCKER',
      test: (c) => c.materialShortageCount === 0,
      explain: (c) =>
        c.materialShortageDetail ??
        `${c.materialShortageCount} material${c.materialShortageCount === 1 ? '' : 's'} short of the required quantity.`,
      action: () => ({ label: 'Review materials', tab: 'materials' }),
    },
    {
      key: 'marker-complete',
      label: 'Marker plan covers the cut quantity',
      severity: 'BLOCKER',
      test: (c) => c.hasMarkers && c.markerCoversRequirement,
      explain: (c) =>
        !c.hasMarkers
          ? 'No lay plan has been recorded, so the cutting room has nothing to spread to.'
          : `The lay plan is ${Math.abs(c.markerShortfall).toLocaleString()} pieces short of the cut requirement.`,
      action: () => ({ label: 'Complete the lay plan', tab: 'cutting' }),
    },
    {
      key: 'approvals-clear',
      label: 'Customer approvals obtained',
      severity: 'BLOCKER',
      test: (c) => !c.hasPendingBlockingApproval,
      explain: (c) =>
        `${c.pendingApprovalLabel ?? 'A customer approval'} is still outstanding, and work that depends on it cannot start.`,
      action: () => ({ label: 'Chase the approval', tab: 'approvals' }),
    },
    {
      key: 'materials-issued',
      label: 'Materials issued to the floor',
      severity: 'WARNING',
      test: (c) => c.bomFullyIssued,
      explain: () => 'Some materials have not been issued from the warehouse yet.',
      action: () => ({ label: 'Issue materials', tab: 'bom' }),
    },
  ],

  [StageKey.EXTERNAL_ORDER]: [
    {
      key: 'external-approval',
      label: 'Approval obtained before release',
      severity: 'BLOCKER',
      test: (c) => c.externalOpsBlocked === 0,
      explain: (c) =>
        `${c.externalOpsBlocked} external operation${c.externalOpsBlocked === 1 ? '' : 's'} require customer approval before release.`,
      action: () => ({ label: 'Open external operations', tab: 'external' }),
    },
  ],

  [StageKey.PRODUCTION_FOLLOW_UP]: [
    {
      key: 'cut-done',
      label: 'Fabric cut',
      severity: 'BLOCKER',
      test: (c) => c.cutQty > 0,
      explain: () => 'Nothing has been cut, so there is nothing for the line to sew.',
      action: () => ({ label: 'Open cutting', tab: 'cutting' }),
    },
    {
      key: 'quality-clear',
      label: 'No open quality failure',
      severity: 'BLOCKER',
      test: (c) => !c.hasOpenQualityFailure,
      explain: () => 'A failed inspection has an open corrective action. Production is held until it is closed.',
      action: () => ({ label: 'Close the corrective action', tab: 'quality' }),
    },
  ],

  [StageKey.AUDIT]: [
    {
      key: 'something-produced',
      label: 'Production available to inspect',
      severity: 'BLOCKER',
      test: (c) => c.producedQty > 0,
      explain: () => 'Nothing has been produced yet, so there is nothing to inspect.',
      action: () => ({ label: 'Open production', tab: 'production' }),
    },
  ],

  [StageKey.PACKING]: [
    {
      key: 'quality-passed',
      label: 'Final inspection passed',
      severity: 'BLOCKER',
      test: (c) => c.qualityInspected && !c.hasOpenQualityFailure,
      explain: (c) =>
        c.hasOpenQualityFailure
          ? 'The final inspection failed and the corrective action is still open.'
          : 'No final inspection has been recorded.',
      action: () => ({ label: 'Record the inspection', tab: 'quality' }),
    },
  ],

  [StageKey.INVOICE]: [
    {
      key: 'packing-approved',
      label: 'Packing list approved',
      severity: 'BLOCKER',
      test: (c) => c.hasCartons && c.packingApproved,
      explain: (c) =>
        !c.hasCartons
          ? 'No cartons have been recorded, so there is no packing list to ship against.'
          : 'The packing list has not been approved by the coordinator.',
      action: () => ({ label: 'Open packing', tab: 'packing' }),
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

export interface Blocker {
  stageKey: StageKey;
  stageLabel: string;
  key: string;
  requirement: string;
  detail: string;
  severity: 'BLOCKER' | 'WARNING';
  actionLabel: string | null;
  tab: string | null;
}

export interface StageGateResult {
  stageKey: StageKey;
  requirements: Array<{
    key: string;
    label: string;
    met: boolean;
    detail: string | null;
    severity: 'BLOCKER' | 'WARNING';
    actionLabel: string | null;
    tab: string | null;
  }>;
  /** Nothing at BLOCKER severity is unmet. */
  canStart: boolean;
  blockers: Blocker[];
  warnings: Blocker[];
}

/** Evaluate one stage's gates against the order. */
export function evaluateStageGates(
  stageKey: StageKey,
  ctx: GateContext,
  stageLabel: string,
): StageGateResult {
  const gates = STAGE_GATES[stageKey] ?? [];
  const requirements = gates.map((g) => {
    const met = g.test(ctx);
    const action = met ? null : (g.action?.(ctx) ?? null);
    return {
      key: g.key,
      label: g.label,
      met,
      detail: met ? null : g.explain(ctx),
      severity: g.severity,
      actionLabel: action?.label ?? null,
      tab: action?.tab ?? null,
    };
  });

  const toBlocker = (r: (typeof requirements)[number]): Blocker => ({
    stageKey,
    stageLabel,
    key: r.key,
    requirement: r.label,
    detail: r.detail ?? '',
    severity: r.severity,
    actionLabel: r.actionLabel,
    tab: r.tab,
  });

  const unmet = requirements.filter((r) => !r.met);
  return {
    stageKey,
    requirements,
    canStart: unmet.every((r) => r.severity !== 'BLOCKER'),
    blockers: unmet.filter((r) => r.severity === 'BLOCKER').map(toBlocker),
    warnings: unmet.filter((r) => r.severity === 'WARNING').map(toBlocker),
  };
}

/**
 * Evaluate every gated stage and return the order's blockers.
 *
 * Deliberately evaluates *all* stages rather than only the current one. A
 * coordinator who can see that cutting will be blocked in three days — because
 * the fabric is not there — can do something about it today. Only showing the
 * current stage's problems is how a factory discovers a shortage on the morning
 * it needs the fabric.
 */
export function evaluateAllGates(
  ctx: GateContext,
  stageLabels: Partial<Record<StageKey, string>>,
): {
  byStage: StageGateResult[];
  blockers: Blocker[];
  warnings: Blocker[];
  /** The stages a coordinator could start right now. */
  readyStages: StageKey[];
} {
  const byStage: StageGateResult[] = [];

  for (const key of Object.keys(STAGE_GATES) as StageKey[]) {
    byStage.push(evaluateStageGates(key, ctx, stageLabels[key] ?? key));
  }

  return {
    byStage,
    // A completed stage's gates are history — reporting them would tell the
    // coordinator that finished work is blocked.
    blockers: byStage.filter((s) => !ctx.completedStages.has(s.stageKey)).flatMap((s) => s.blockers),
    warnings: byStage.filter((s) => !ctx.completedStages.has(s.stageKey)).flatMap((s) => s.warnings),
    readyStages: byStage.filter((s) => s.canStart && !ctx.completedStages.has(s.stageKey)).map((s) => s.stageKey),
  };
}
