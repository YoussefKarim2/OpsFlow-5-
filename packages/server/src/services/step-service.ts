/**
 * The guided order routine — assembling the step context and recording what a
 * person decides about a step.
 *
 * The definitions themselves live in `@opsflow/shared/order-steps.ts`, next to
 * the calculation engine and away from Prisma, so the web client can render a
 * step rail from the same rules the API applies. This file does the two things
 * that need a database:
 *
 *   1. `loadStepExtras` — the four counts the derivation needs that the order
 *      query does not already carry.
 *   2. `setStepStatus` — write down what a person decided, when the data alone
 *      cannot say. Marking a step "not required" or "waiting" is a statement by
 *      a named human, so it is stored with their name and an explicit reason.
 *
 * Nothing here decides a step's state. That is `deriveOrderSteps()`, and it
 * runs on every read, so a step cannot go stale the way a stored status can.
 */

import {
  StageKey, StageStatus, STAGE_META, StepState, STEP_BY_KEY,
  deriveOrderSteps, sum,
  type OrderStepsResult, type Blocker,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { NotFoundError, ValidationError, ConflictError } from '../errors.js';
import { logActivity } from './activity-service.js';
import { ORDER_INCLUDE, deriveOrder } from './order-service.js';
import { buildStepContext, blockedStepKeys, type StepExtras } from './step-context.js';

// ─────────────────────────────────────────────────────────────────────────────
// The extra counts the step context needs
//
// Deliberately a second, tiny query rather than more `include` on ORDER_INCLUDE.
// ORDER_INCLUDE is loaded once per row by the orders list; hanging four more
// relations off it would make every list page pay for the workspace's needs.
// ─────────────────────────────────────────────────────────────────────────────


export async function loadStepExtras(orderId: string): Promise<StepExtras> {
  const [attachments, instructions, proforma, stock] = await Promise.all([
    prisma.attachment.count({ where: { orderId } }),
    prisma.customInstruction.count({ where: { orderId } }),
    prisma.proformaInvoice.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, _count: { select: { lines: true } } },
    }),
    prisma.stockRecord.findMany({ where: { orderId }, select: { availableQty: true } }),
  ]);

  return {
    referenceFileCount: attachments,
    customInstructionCount: instructions,
    hasProformaInvoice: proforma != null,
    proformaLineCount: proforma?._count.lines ?? 0,
    stockQty: sum(stock.map((s) => s.availableQty)),
    // A stock row that reads zero is still an answer — somebody looked and
    // found none. `stockQty > 0` would treat "checked, none" as "not checked".
    stockRecorded: stock.length > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording a person's decision
// ─────────────────────────────────────────────────────────────────────────────

/** The states a person may set by hand. The rest are derived, never written. */
const SETTABLE = new Set<string>([
  StageStatus.COMPLETED,
  StageStatus.WAITING,
  StageStatus.BLOCKED,
  StageStatus.NOT_REQUIRED,
]);

export interface SetStepInput {
  orderId: string;
  stageKey: StageKey;
  /** Null clears the override and hands the step back to the derivation. */
  status: StageStatus | null;
  reason?: string | null;
  notes?: string | null;
  actorId: string;
  actorName: string;
}

/**
 * Record what a person decided about a step.
 *
 * Three rules, each learned from the workbook's own failures:
 *
 * **"Not required" needs a reason.** The sheet is full of blank cells that
 * might mean "not applicable" and might mean "nobody did it". A reason turns
 * the first into a statement and makes the second impossible to disguise.
 *
 * **Reopening is clearing, not a new state.** Setting a completed step back to
 * "in progress" would be a second guess stored over the top of the data. Clear
 * the override and the derivation answers again, honestly.
 *
 * **Everything is logged.** The activity feed gets a human sentence, because
 * "who decided this order needed no printing?" is asked weeks later.
 */
export async function setStepStatus(input: SetStepInput) {
  const def = STEP_BY_KEY[input.stageKey];
  if (!def) throw new ValidationError(`"${input.stageKey}" is not a step in the order routine`);

  if (input.status != null && !SETTABLE.has(input.status)) {
    throw new ValidationError(
      `A step cannot be set to "${input.status}" by hand — that state is worked out from the order's own data.`,
    );
  }

  const reason = input.reason?.trim() || null;
  if (input.status === StageStatus.NOT_REQUIRED && !reason) {
    throw new ValidationError(
      `Say why "${def.label}" is not required for this order. A blank reason is what makes a skipped step ` +
      `indistinguishable from a forgotten one six weeks later.`,
    );
  }

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { id: true, poNumber: true, cancelled: true },
  });
  if (!order) throw new NotFoundError('Order');
  if (order.cancelled) throw new ConflictError('This order is cancelled. Reopen it before changing its steps.');

  const now = new Date();
  const completing = input.status === StageStatus.COMPLETED;

  const stage = await prisma.orderStage.upsert({
    where: { orderId_stageKey: { orderId: order.id, stageKey: input.stageKey } },
    create: {
      orderId: order.id,
      stageKey: input.stageKey,
      statusOverride: input.status,
      notRequiredReason: input.status === StageStatus.NOT_REQUIRED ? reason : null,
      notes: input.notes ?? null,
      completedAt: completing ? now : null,
      completedById: completing ? input.actorId : null,
      startedAt: now,
    },
    update: {
      statusOverride: input.status,
      notRequiredReason: input.status === StageStatus.NOT_REQUIRED ? reason : null,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      completedAt: completing ? now : null,
      completedById: completing ? input.actorId : null,
    },
  });

  const label = def.label;
  const summary =
    input.status === null ? `Reopened "${label}" — its state is worked out from the order again`
    : input.status === StageStatus.COMPLETED ? `Marked "${label}" complete`
    : input.status === StageStatus.NOT_REQUIRED ? `Marked "${label}" not required: ${reason}`
    : input.status === StageStatus.WAITING ? `Put "${label}" on hold${reason ? `: ${reason}` : ''}`
    : `Flagged "${label}" as blocked${reason ? `: ${reason}` : ''}`;

  await logActivity({
    orderId: order.id,
    actorId: input.actorId,
    actorName: input.actorName,
    action: 'step.status',
    summary,
    entityType: 'OrderStage',
    entityId: stage.id,
    meta: { stageKey: input.stageKey, status: input.status ?? null, reason },
  });

  return stage;
}

/**
 * Mark a step as started, without claiming any work was done.
 *
 * Used by the "Start this step" button on the guided rail. It records a
 * timestamp and nothing else — deliberately. Starting a step is not evidence
 * that anything happened in it, and the derivation still decides when it is
 * finished.
 */
export async function markStepStarted(orderId: string, stageKey: StageKey) {
  if (!STEP_BY_KEY[stageKey]) throw new ValidationError(`"${stageKey}" is not a step in the order routine`);
  return prisma.orderStage.upsert({
    where: { orderId_stageKey: { orderId, stageKey } },
    create: { orderId, stageKey, startedAt: new Date() },
    update: { startedAt: new Date() },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderStepsPayload extends OrderStepsResult {
  orderId: string;
  poNumber: string;
  /** The blockers behind any BLOCKED step, so the rail can say what to do. */
  blockers: Blocker[];
}

/**
 * Every step of one order, with its state worked out from the order's own data.
 *
 * The blockers come from the same `evaluateAllGates` call that produces them
 * for the Overview and the dashboard — the rail cannot say "blocked" for a
 * reason the rest of the app does not also show.
 */
export async function getOrderSteps(orderId: string, today = new Date()): Promise<OrderStepsPayload> {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: orderId }, { poNumber: orderId }] },
    include: ORDER_INCLUDE,
  });
  if (!order) throw new NotFoundError('Order');

  const [extras, derivedOrder] = await Promise.all([
    loadStepExtras(order.id),
    Promise.resolve(deriveOrder(order, today)),
  ]);

  const ctx = buildStepContext(order, extras, {
    materialShortCount: derivedOrder.materials?.shortCount ?? 0,
    markerPlannedQty: derivedOrder.markerPlan?.plannedTotal ?? 0,
    markerRequiredQty: derivedOrder.markerPlan?.requiredTotal ?? 0,
  }, today);

  const result = deriveOrderSteps(ctx, blockedStepKeys(derivedOrder.blockers));

  return {
    ...result,
    orderId: order.id,
    poNumber: order.poNumber,
    blockers: derivedOrder.blockers,
  };
}

export { buildStepContext, blockedStepKeys } from './step-context.js';
export type { StepOrderInput, StepDerivedInput, StepExtras } from './step-context.js';
export { deriveOrderSteps, StepState, STAGE_META };
