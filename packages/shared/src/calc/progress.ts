/**
 * Progress and status derivation.
 *
 * The brief's section 7 is emphatic: progress must not be a typed-in number.
 * Here stage progress is `completed tasks / total tasks` and order progress is
 * the weighted roll-up of stage progress using STAGE_META weights. Nobody can
 * type 90% into an order that has not been cut.
 */

import {
  StageKey, StageStatus, TaskStatus, OrderStatus, Health, STAGE_META, Priority,
} from '../enums.js';
import { safePct, daysBetween, clamp } from './num.js';

export interface TaskLike {
  id: string;
  stageKey: StageKey;
  title: string;
  status: TaskStatus;
  priority: Priority;
  dueDate?: string | Date | null;
  completedAt?: string | Date | null;
  assigneeName?: string | null;
  department?: string | null;
  sequence?: number;
}

export interface StageProgress {
  stageKey: StageKey;
  label: string;
  order: number;
  weight: number;
  group: 'ORDER' | 'MATERIALS' | 'PRODUCTION' | 'DELIVERY';
  totalTasks: number;
  completedTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  progressPct: number;
  status: StageStatus;
  /** The next task waiting in this stage, if any. */
  nextTask: TaskLike | null;
}

function isOverdue(t: TaskLike, today: Date): boolean {
  if (t.status === TaskStatus.COMPLETED || !t.dueDate) return false;
  const d = daysBetween(today, t.dueDate);
  return d != null && d < 0;
}

/** Per-stage roll-up from the stage's tasks. */
export function computeStageProgress(tasks: readonly TaskLike[], today: Date = new Date()): StageProgress[] {
  return (Object.keys(STAGE_META) as StageKey[])
    .map((stageKey) => {
      const meta = STAGE_META[stageKey];
      const stageTasks = tasks.filter((t) => t.stageKey === stageKey);
      const total = stageTasks.length;
      const completed = stageTasks.filter((t) => t.status === TaskStatus.COMPLETED).length;
      const blocked = stageTasks.filter((t) => t.status === TaskStatus.BLOCKED).length;
      const overdue = stageTasks.filter((t) => isOverdue(t, today)).length;
      const inProgress = stageTasks.some((t) => t.status === TaskStatus.IN_PROGRESS);
      const waiting = stageTasks.some((t) => t.status === TaskStatus.WAITING);

      const progressPct = total === 0 ? 0 : Math.round((completed / total) * 100);

      let status: StageStatus;
      if (total === 0) status = StageStatus.NOT_STARTED;
      else if (completed === total) status = StageStatus.COMPLETED;
      else if (blocked > 0) status = StageStatus.BLOCKED;
      else if (overdue > 0) status = StageStatus.OVERDUE;
      else if (inProgress) status = StageStatus.IN_PROGRESS;
      else if (waiting) status = StageStatus.WAITING;
      else if (completed > 0) status = StageStatus.IN_PROGRESS;
      else status = StageStatus.NOT_STARTED;

      const nextTask =
        [...stageTasks]
          .filter((t) => t.status !== TaskStatus.COMPLETED)
          .sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99))[0] ?? null;

      return {
        stageKey, label: meta.label, order: meta.order, weight: meta.weight, group: meta.group,
        totalTasks: total, completedTasks: completed, blockedTasks: blocked, overdueTasks: overdue,
        progressPct, status, nextTask,
      };
    })
    .sort((a, b) => a.order - b.order);
}

/**
 * Weighted order progress. Stages with no tasks are excluded from the
 * denominator rather than counted as 0% — an order that legitimately has no
 * external operations should not be permanently capped below 100%.
 */
export function computeOrderProgress(stages: readonly StageProgress[]): number {
  const active = stages.filter((s) => s.totalTasks > 0);
  if (active.length === 0) return 0;
  const totalWeight = active.reduce((a, s) => a + s.weight, 0);
  if (totalWeight === 0) return 0;
  const earned = active.reduce((a, s) => a + s.weight * (s.progressPct / 100), 0);
  return Math.round(clamp((earned / totalWeight) * 100, 0, 100));
}

/**
 * The stage the order is "in".
 *
 * Ordered by the *process sequence* of its outstanding work, not by the stage's
 * display position. Progress Status is stage 4 on the sidebar but its single
 * task is sequence 14 — the last thing anyone does — so ordering by display
 * position would answer "what's next?" with "log your time".
 */
export function currentStage(stages: readonly StageProgress[]): StageProgress | null {
  const open = stages.filter((s) => s.totalTasks > 0 && s.status !== StageStatus.COMPLETED);
  if (open.length === 0) return null;

  // A blocked stage outranks everything: it is the thing actually stopping the order.
  const blocked = open.filter((s) => s.status === StageStatus.BLOCKED);
  const pool = blocked.length > 0 ? blocked : open;

  return [...pool].sort((a, b) => {
    const sa = a.nextTask?.sequence ?? 99;
    const sb = b.nextTask?.sequence ?? 99;
    return sa - sb || a.order - b.order;
  })[0]!;
}

export interface OrderStatusInput {
  cancelled: boolean;
  hasOpenQualityFailure: boolean;
  shipmentStatus?: 'NOT_READY' | 'READY' | 'BOOKED' | 'SHIPPED' | 'DELIVERED' | null;
  orderQty: number;
  producedQty: number;
  packedQty: number;
  shippedQty: number;
  qualityPassedQty: number;
  packingApproved: boolean;
  materialsFullyIssued: boolean;
  hasPendingBlockingApproval: boolean;
  isBehindSchedule: boolean;
  anyTaskStarted: boolean;
}

/**
 * Order status, evaluated top-down — first match wins. Section 31 of the brief.
 * Order matters: a quality block outranks "in production" because the
 * coordinator needs the blocker, not the happy-path label.
 */
export function deriveOrderStatus(i: OrderStatusInput): OrderStatus {
  if (i.cancelled) return OrderStatus.CANCELLED;
  if (i.hasOpenQualityFailure) return OrderStatus.QUALITY_BLOCKED;
  if (i.shipmentStatus === 'DELIVERED') return OrderStatus.COMPLETED;
  if (i.shipmentStatus === 'SHIPPED' || i.shippedQty >= i.orderQty && i.orderQty > 0) return OrderStatus.SHIPPED;
  if (i.packedQty > 0 && i.packedQty >= i.producedQty && i.packingApproved) return OrderStatus.READY_TO_SHIP;
  if (i.packedQty > 0) return OrderStatus.PACKING;
  if (i.orderQty > 0 && i.producedQty >= i.orderQty && i.qualityPassedQty < i.producedQty) return OrderStatus.QUALITY_CHECK;
  if (i.isBehindSchedule && i.producedQty > 0) return OrderStatus.PRODUCTION_DELAYED;
  if (i.producedQty > 0) return OrderStatus.IN_PRODUCTION;
  if (i.hasPendingBlockingApproval) return OrderStatus.WAITING_APPROVAL;
  if (i.materialsFullyIssued) return OrderStatus.READY_FOR_PRODUCTION;
  if (i.anyTaskStarted) return OrderStatus.DRAFT;
  return OrderStatus.DRAFT;
}

/** Traffic light per the brief's colour legend. */
export function deriveHealth(i: {
  status: OrderStatus;
  daysRemaining: number | null;
  isBehindSchedule: boolean;
  criticalAlerts: number;
  warningAlerts: number;
  progressPct: number;
}): Health {
  if (i.status === OrderStatus.CANCELLED) return Health.NOT_STARTED;
  if (i.status === OrderStatus.COMPLETED || i.status === OrderStatus.SHIPPED) return Health.ON_TRACK;
  if (i.criticalAlerts > 0) return Health.LATE;
  if (i.isBehindSchedule) return Health.LATE;
  if (i.daysRemaining != null && i.daysRemaining < 0) return Health.LATE;
  if (i.status === OrderStatus.WAITING_APPROVAL || i.status === OrderStatus.QUALITY_BLOCKED) return Health.WAITING;
  if (i.warningAlerts > 0) return Health.ATTENTION;
  if (i.daysRemaining != null && i.daysRemaining <= 7 && i.progressPct < 90) return Health.ATTENTION;
  if (i.progressPct === 0) return Health.NOT_STARTED;
  return Health.ON_TRACK;
}

/**
 * The brief's legend is "RED = Late / Problem". An order twenty days from its
 * date with a blocking approval outstanding is a problem but is not late, and
 * labelling it "Late" trains people to distrust the badge.
 */
export const HEALTH_STYLE: Record<Health, { label: string; dot: string; chip: string }> = {
  ON_TRACK:    { label: 'On Track',  dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  ATTENTION:   { label: 'Attention', dot: 'bg-amber-500',   chip: 'bg-amber-50 text-amber-800 ring-amber-600/20' },
  LATE:        { label: 'Problem',   dot: 'bg-red-500',     chip: 'bg-red-50 text-red-700 ring-red-600/20' },
  WAITING:     { label: 'Waiting',   dot: 'bg-blue-500',    chip: 'bg-blue-50 text-blue-700 ring-blue-600/20' },
  NOT_STARTED: { label: 'Not Started', dot: 'bg-slate-400', chip: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
};

/**
 * "Who needs to do the next task" — question 6 of the brief, answered as a
 * single sentence for the dashboard's Next Action column.
 */
export function deriveNextAction(stages: readonly StageProgress[]): { text: string; department: string | null; taskId: string | null } {
  const stage = currentStage(stages);
  if (!stage) return { text: 'Order complete', department: null, taskId: null };
  const t = stage.nextTask;
  if (!t) return { text: `Start ${stage.label}`, department: null, taskId: null };
  return { text: t.title, department: t.department ?? null, taskId: t.id };
}

export function stageStatusIcon(s: StageStatus): string {
  switch (s) {
    case StageStatus.COMPLETED: return '✓';
    case StageStatus.IN_PROGRESS: return '●';
    case StageStatus.BLOCKED: return '⚠';
    case StageStatus.OVERDUE: return '!';
    case StageStatus.WAITING: return '◐';
    default: return '○';
  }
}
