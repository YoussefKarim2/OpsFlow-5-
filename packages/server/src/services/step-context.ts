/**
 * Turning an order's database rows into the flat facts the step definitions read.
 *
 * Split out of `step-service.ts` deliberately: this module imports nothing at
 * runtime but `@opsflow/shared`, so it can be tested without a database, an
 * environment file or an HTTP server. The layer it covers is the one where a
 * mistyped column name is invisible — a step simply reads "Not started"
 * forever — so it needs to be cheap to test by value.
 */

import type { Prisma } from '@prisma/client';
import {
  StageKey, StageStatus, STEP_BY_KEY, QtyLedger, sum,
  type StepContext, type Blocker,
} from '@opsflow/shared';
/** The counts `loadStepExtras` in step-service.ts fetches for the derivation. */
export interface StepExtras {
  referenceFileCount: number;
  customInstructionCount: number;
  hasProformaInvoice: boolean;
  proformaLineCount: number;
  stockQty: number;
  stockRecorded: boolean;
}


// ─────────────────────────────────────────────────────────────────────────────
// Building the context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shape `buildStepContext` needs from an order. Declared structurally
 * rather than as `FullOrder` so the function can be tested with a plain object
 * and so it states exactly what it reads.
 */
export interface StepOrderInput {
  clientId: string | null;
  poNumber: string | null;
  orderName: string | null;
  styleNumber: string | null;
  itemType: string | null;
  requiredDeliveryDate: Date | null;
  pricePerPieceUsd: Prisma.Decimal | number | null;
  fabric: string | null;
  externalWorkSort: string | null;
  externalWorkType: string | null;
  colors: Array<unknown>;
  sizes: Array<unknown>;
  quantities: Array<{ ledger: string; qty: number }>;
  markers: Array<unknown>;
  bomItems: Array<{ requiredQty: unknown; issuedQty: unknown }>;
  externalOperations: Array<{ status: string; requiresApproval: boolean; approval?: { status: string } | null }>;
  productionRecords: Array<{ qty: number }>;
  qualityAudits: Array<{ result: string }>;
  packingLists: Array<{ approved: boolean; cartons: Array<{ qty: number }> }>;
  shipments: Array<{ qty: number; status: string; actualShippingDate: Date | null }>;
  costing: { lines: Array<unknown> } | null;
  tasks: Array<{ stageKey: string; status: string; dueDate: Date | null }>;
  stages: Array<{
    stageKey: string;
    statusOverride: string | null;
    notRequiredReason: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    notes: string | null;
  }>;
}

/**
 * The two facts the step context needs that only the full derivation knows.
 * Passed in rather than recomputed, so the step rail and the Materials tab can
 * never disagree about whether the fabric is short.
 */
export interface StepDerivedInput {
  /** BOM lines whose material does not exist in the quantity required. */
  materialShortCount: number;
  /** Pieces the lay plan produces, against the pieces the cut order needs. */
  markerPlannedQty: number;
  markerRequiredQty: number;
}

/**
 * The order's facts, flattened for the step definitions.
 *
 * Every field answers "has anybody recorded this?" — never "is this good?".
 * Judgement stays in the step definitions, where it is readable by someone who
 * knows the factory and not the codebase.
 */
export function buildStepContext(
  order: StepOrderInput,
  extras: StepExtras,
  derived: StepDerivedInput = { materialShortCount: 0, markerPlannedQty: 0, markerRequiredQty: 0 },
  today = new Date(),
): StepContext {
  const totalFor = (ledger: QtyLedger) =>
    sum(order.quantities.filter((q) => q.ledger === ledger).map((q) => q.qty));

  const num = (v: unknown): number => (v == null ? 0 : Number(v.toString()));

  const bomFullyIssued =
    order.bomItems.length > 0 &&
    order.bomItems.every((b) => num(b.issuedQty) >= num(b.requiredQty) && num(b.requiredQty) > 0);

  const producedQty = sum(order.productionRecords.map((p) => p.qty));
  const packedQty = sum(order.packingLists.flatMap((p) => p.cartons.map((c) => c.qty)));
  const cartonCount = sum(order.packingLists.map((p) => p.cartons.length));
  const latestPacking = order.packingLists[order.packingLists.length - 1];

  const decided = order.qualityAudits.filter((a) => a.result !== 'PENDING');

  // Task counts per step, for the steps whose completion is a task list rather
  // than a record — Progress Status above all.
  const taskCounts: StepContext['taskCounts'] = {};
  for (const t of order.tasks) {
    const key = t.stageKey as StageKey;
    const bucket = (taskCounts[key] ??= { total: 0, completed: 0, overdue: 0 });
    bucket.total += 1;
    if (t.status === 'COMPLETED') bucket.completed += 1;
    else if (t.dueDate && t.dueDate < today) bucket.overdue += 1;
  }

  const overrides: StepContext['overrides'] = {};
  for (const s of order.stages) {
    const key = s.stageKey as StageKey;
    if (!STEP_BY_KEY[key]) continue;
    overrides[key] = {
      status: (s.statusOverride as StageStatus | null) ?? null,
      completedAt: s.completedAt,
      startedAt: s.startedAt,
      notRequiredReason: s.notRequiredReason,
      notes: s.notes,
    };
  }

  return {
    referenceFileCount: extras.referenceFileCount,

    hasClient: Boolean(order.clientId),
    hasPoNumber: Boolean(order.poNumber),
    hasOrderName: Boolean(order.orderName),
    hasStyleNumber: Boolean(order.styleNumber),
    hasItemType: Boolean(order.itemType),
    hasRequiredDate: Boolean(order.requiredDeliveryDate),
    hasPrice: order.pricePerPieceUsd != null && num(order.pricePerPieceUsd) > 0,
    hasFabric: Boolean(order.fabric),

    orderQty: totalFor(QtyLedger.ORDER),
    quantityCellCount: order.quantities.filter((q) => q.ledger === QtyLedger.ORDER && q.qty > 0).length,
    colorCount: order.colors.length,
    sizeCount: order.sizes.length,

    cutQty: totalFor(QtyLedger.CUT),
    stockQty: extras.stockQty,
    stockRecorded: extras.stockRecorded,

    markerCount: order.markers.length,
    // A lay plan is finished when it produces at least what the cut order asks
    // for. Counting markers alone would call one marker out of six a plan.
    markerCoversRequirement:
      derived.markerRequiredQty > 0 && derived.markerPlannedQty >= derived.markerRequiredQty,

    bomLineCount: order.bomItems.length,
    bomFullyIssued,
    materialShortCount: derived.materialShortCount,

    customInstructionCount: extras.customInstructionCount,

    // "Declared" means somebody typed the external work onto the order, which
    // is how the workbook says an order needs printing before any operation
    // row exists. Without this, step 5 would look inapplicable right up until
    // the moment it was already late.
    externalWorkDeclared: Boolean(order.externalWorkSort || order.externalWorkType),
    externalOpCount: order.externalOperations.length,
    externalOpsReturned: order.externalOperations.filter((op) => op.status === 'RETURNED').length,
    externalOpsBlocked: order.externalOperations.filter(
      (op) => op.requiresApproval && op.approval?.status !== 'APPROVED' && op.status !== 'RETURNED',
    ).length,

    producedQty,
    productionRecordCount: order.productionRecords.length,

    auditCount: decided.length,
    auditPassed: decided.length > 0 && decided.every((a) => a.result === 'PASS'),
    openQualityFailure: order.qualityAudits.some((a) => a.result === 'FAIL'),

    cartonCount,
    packedQty,
    packingApproved: latestPacking?.approved ?? false,

    hasCosting: order.costing != null,
    costLineCount: order.costing?.lines.length ?? 0,

    hasProformaInvoice: extras.hasProformaInvoice,
    proformaLineCount: extras.proformaLineCount,

    // Only shipments that have actually gone count as shipped. A booked
    // shipment is a plan; the workbook's Invoice sheet records the date it left.
    shippedQty: sum(order.shipments.filter((s) => s.actualShippingDate != null).map((s) => s.qty)),
    shipmentBooked: order.shipments.some((s) => s.status !== 'NOT_READY'),

    taskCounts,
    overrides,
  };
}

/** Blockers, reduced to the set of steps that cannot proceed. */
export function blockedStepKeys(blockers: readonly Blocker[]): Set<StageKey> {
  return new Set(blockers.filter((b) => b.severity === 'BLOCKER').map((b) => b.stageKey));
}
