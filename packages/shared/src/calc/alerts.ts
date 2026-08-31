/**
 * The alert engine — the brief's section 21.
 *
 * One function, three surfaces. The dashboard, the order overview and the
 * Follow-Up centre all render the array this returns. That is deliberate: the
 * failure mode of the workbook is that the same problem looks different
 * depending on which tab you opened.
 *
 * Every alert carries a `nextAction` because "there is a problem" is not
 * actionable and "get printing approval from the customer" is.
 */

import { AlertCode, AlertSeverity, ApprovalStatus, ExternalOpStatus, TaskStatus } from '../enums.js';
import { daysBetween } from './num.js';
import type { BomSummary } from './materials.js';
import type { MaterialPosition, ConsumptionVariance } from './inventory.js';
import type { Blocker } from './workflow-gates.js';
import type { ProductionAnalytics } from './production.js';
import type { TaskLike } from './progress.js';

export interface Alert {
  code: AlertCode;
  severity: AlertSeverity;
  title: string;
  detail: string;
  nextAction: string;
  /** Deep link target within the order workspace, e.g. 'bom' | 'external' | 'production'. */
  tab?: string;
  entityId?: string;
  /** Sort key — lower is more urgent. */
  rank: number;
}

const RANK: Record<AlertSeverity, number> = { CRITICAL: 0, WARNING: 100, ATTENTION: 200, OK: 300 };

export interface AlertContext {
  today?: Date;
  order: {
    poNumber: string;
    requiredDeliveryDate?: string | Date | null;
    promisedShippingDate?: string | Date | null;
    orderQty: number;
    packedQty: number;
    producedQty: number;
  };
  tasks: readonly TaskLike[];
  bom?: BomSummary | null;
  /** Requirements measured against real stock, where materials are linked. */
  materials?: MaterialPosition | null;
  /** Unmet stage requirements, already derived by the gate engine. */
  blockers?: readonly Blocker[];
  consumption?: readonly ConsumptionVariance[];
  production?: ProductionAnalytics | null;
  approvals?: ReadonlyArray<{
    id: string; type: string; status: ApprovalStatus; blocking: boolean; requestedDate?: string | Date | null;
  }>;
  externalOps?: ReadonlyArray<{
    id: string; operationType: string; status: ExternalOpStatus; requiresApproval: boolean;
    approvalCleared: boolean; expectedReturnDate?: string | Date | null; actualReturnDate?: string | Date | null;
  }>;
  quality?: ReadonlyArray<{ id: string; result: 'PASS' | 'FAIL' | 'PENDING'; correctiveActionClosed: boolean }>;
}

const SHIP_WARNING_DAYS = 7;

export function evaluateAlerts(ctx: AlertContext): Alert[] {
  const today = ctx.today ?? new Date();
  const out: Alert[] = [];
  const push = (a: Omit<Alert, 'rank'>) => out.push({ ...a, rank: RANK[a.severity] });

  // --- Dates -------------------------------------------------------------
  const daysToDelivery = daysBetween(today, ctx.order.requiredDeliveryDate);
  const daysToShip = daysBetween(today, ctx.order.promisedShippingDate);
  const complete = ctx.order.orderQty > 0 && ctx.order.packedQty >= ctx.order.orderQty;

  if (daysToDelivery != null && daysToDelivery < 0 && !complete) {
    push({
      code: AlertCode.ORDER_OVERDUE, severity: AlertSeverity.CRITICAL,
      title: 'Order is overdue',
      detail: `Required delivery was ${Math.abs(daysToDelivery)} day${Math.abs(daysToDelivery) === 1 ? '' : 's'} ago and the order is not complete.`,
      nextAction: 'Escalate to the factory manager and agree a revised date with the customer',
      tab: 'overview',
    });
  } else if (daysToShip != null && daysToShip >= 0 && daysToShip <= SHIP_WARNING_DAYS && !complete) {
    push({
      code: AlertCode.SHIP_DATE_APPROACHING, severity: AlertSeverity.ATTENTION,
      title: 'Shipping date approaching',
      detail: `${daysToShip} day${daysToShip === 1 ? '' : 's'} until the promised shipping date.`,
      nextAction: 'Confirm packing and booking are on track',
      tab: 'shipping',
    });
  }

  // --- Approvals ---------------------------------------------------------
  for (const a of ctx.approvals ?? []) {
    if (a.status === ApprovalStatus.PENDING && a.blocking) {
      const waiting = daysBetween(a.requestedDate ?? today, today);
      push({
        code: AlertCode.APPROVAL_PENDING, severity: AlertSeverity.CRITICAL,
        title: 'Customer approval required',
        detail: `${humanise(a.type)} approval is pending${waiting != null && waiting > 0 ? ` — ${waiting} day${waiting === 1 ? '' : 's'} outstanding` : ''}. Dependent work cannot start.`,
        nextAction: `Chase the customer for ${humanise(a.type).toLowerCase()} approval`,
        tab: 'approvals', entityId: a.id,
      });
    } else if (a.status === ApprovalStatus.REJECTED || a.status === ApprovalStatus.CHANGES_REQUESTED) {
      push({
        code: AlertCode.APPROVAL_PENDING, severity: AlertSeverity.WARNING,
        title: `Approval ${a.status === ApprovalStatus.REJECTED ? 'rejected' : 'needs changes'}`,
        detail: `${humanise(a.type)} was returned by the customer.`,
        nextAction: 'Revise and resubmit for approval',
        tab: 'approvals', entityId: a.id,
      });
    }
  }

  // --- External operations ----------------------------------------------

  // A print order split across four colours is one problem, not four. Blocked
  // operations are grouped by operation type so the coordinator sees a single
  // actionable line instead of an alert per colour.
  const blockedOps = (ctx.externalOps ?? []).filter(
    (op) => op.requiresApproval && !op.approvalCleared && op.status !== ExternalOpStatus.RETURNED,
  );
  const blockedByType = new Map<string, typeof blockedOps>();
  for (const op of blockedOps) {
    const arr = blockedByType.get(op.operationType) ?? [];
    arr.push(op);
    blockedByType.set(op.operationType, arr);
  }
  for (const [operationType, ops] of blockedByType) {
    push({
      code: AlertCode.EXTERNAL_OP_BLOCKED, severity: AlertSeverity.CRITICAL,
      title: 'External operation blocked',
      detail:
        `${operationType} cannot start until the customer approves` +
        (ops.length > 1 ? ` — ${ops.length} operations affected.` : '.'),
      nextAction: 'Obtain customer approval before releasing to the external factory',
      tab: 'external', entityId: ops[0]!.id,
    });
  }

  for (const op of ctx.externalOps ?? []) {
    const late = op.expectedReturnDate ? daysBetween(op.expectedReturnDate, today) : null;
    if (!op.actualReturnDate && late != null && late > 0) {
      push({
        code: AlertCode.EXTERNAL_OP_LATE, severity: AlertSeverity.WARNING,
        title: 'External operation late',
        detail: `${op.operationType} is ${late} day${late === 1 ? '' : 's'} past its expected return date.`,
        nextAction: 'Chase the external factory for the return',
        tab: 'external', entityId: op.id,
      });
    }
  }

  // --- Materials ---------------------------------------------------------
  //
  // Two different problems, deliberately two different alerts. Stock that
  // exists but is not yet reserved is a click; stock that does not exist is a
  // purchase order and a phone call. Collapsing them into one "shortage" is how
  // a coordinator learns to ignore the shortage alert.
  if (ctx.materials && ctx.materials.shortCount > 0) {
    const worst = ctx.materials.topShortages[0];
    const many = ctx.materials.shortCount > 1;
    push({
      code: AlertCode.MATERIAL_SHORTAGE,
      severity: AlertSeverity.CRITICAL,
      title: `Not enough stock for ${ctx.materials.shortCount} material${many ? 's' : ''}`,
      detail: worst
        ? `${worst.materialName} needs ${fmtQty(worst.outstandingQty)} ${worst.unit} but only ` +
          `${fmtQty(worst.reservableQty)} is available — short by ${fmtQty(worst.shortQty)} ${worst.unit}.`
        : 'Required materials are not in stock.',
      nextAction: 'Raise a purchase request, or reallocate stock from another order',
      tab: 'materials',
    });
  } else if (ctx.materials && ctx.materials.reservableCount > 0) {
    push({
      code: AlertCode.MATERIAL_UNRESERVED,
      severity: AlertSeverity.ATTENTION,
      title: `${ctx.materials.reservableCount} material${ctx.materials.reservableCount === 1 ? '' : 's'} not yet reserved`,
      detail:
        'The stock is on the shelf but is not committed to this order, so another order could take it.',
      nextAction: 'Reserve the materials for this order',
      tab: 'materials',
    });
  }

  if (ctx.materials && ctx.materials.unlinkedCount > 0) {
    push({
      code: AlertCode.MATERIAL_UNRESERVED,
      severity: AlertSeverity.ATTENTION,
      title: `${ctx.materials.unlinkedCount} BOM line${ctx.materials.unlinkedCount === 1 ? '' : 's'} not linked to stock`,
      detail:
        'These requirements cannot be checked against inventory, so the system cannot tell whether they are covered.',
      nextAction: 'Link each line to a material in the catalogue',
      tab: 'bom',
    });
  }

  // The issued-versus-required view, which is about the warehouse having handed
  // the material over rather than about the material existing.
  if (ctx.bom && ctx.bom.shortItems > 0 && !ctx.materials) {
    const worst = ctx.bom.topShortages[0];
    const many = ctx.bom.shortItems > 1;
    push({
      code: AlertCode.MATERIAL_SHORTAGE,
      severity: ctx.bom.shortItems === ctx.bom.totalItems ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
      title: `Material outstanding on ${ctx.bom.shortItems} item${many ? 's' : ''}`,
      detail: worst
        ? `Worst: ${worst.item}${worst.color ? ` (${worst.color})` : ''} short by ${fmtQty(worst.shortQty)} ${worst.unit}.`
        : 'Outstanding material requirements.',
      nextAction: 'Issue the outstanding materials or raise a purchase order',
      tab: 'bom',
    });
  }

  // --- Consumption -------------------------------------------------------
  for (const v of ctx.consumption ?? []) {
    if (!v.isSignificant) continue;
    push({
      code: AlertCode.CONSUMPTION_VARIANCE,
      severity: v.direction === 'OVER' ? AlertSeverity.WARNING : AlertSeverity.ATTENTION,
      title: `${v.materialName} consumption is ${v.direction === 'OVER' ? 'above' : 'below'} plan`,
      detail:
        `Expected ${fmtQty(v.expectedQty)} ${v.unit} for ${fmtQty(v.piecesProduced)} pieces, ` +
        `used ${fmtQty(v.actualQty)} — a ${v.variancePct == null ? '' : `${Math.abs(Math.round(v.variancePct))}% `}` +
        `${v.direction === 'OVER' ? 'overrun' : 'saving'}.`,
      nextAction:
        v.direction === 'OVER'
          ? 'Check the marker and the lay for waste before the fabric runs short'
          : 'Check whether the BOM consumption rate is too high — it is pricing every future order',
      tab: 'production',
    });
  }

  // --- Stage gates -------------------------------------------------------
  //
  // Blockers are already derived elsewhere; they are surfaced here so a single
  // list answers "what is wrong with this order" whatever the cause. Material
  // and approval blockers are omitted because the alerts above say the same
  // thing with more detail.
  const GATE_ALERTS_HANDLED_ELSEWHERE = new Set(['materials-available', 'approvals-clear', 'external-approval', 'quality-clear']);
  for (const b of ctx.blockers ?? []) {
    if (GATE_ALERTS_HANDLED_ELSEWHERE.has(b.key)) continue;
    push({
      code: AlertCode.STAGE_BLOCKED,
      severity: AlertSeverity.WARNING,
      title: `${b.stageLabel} is blocked`,
      detail: b.detail,
      nextAction: b.actionLabel ?? `Resolve: ${b.requirement}`,
      tab: b.tab ?? 'overview',
    });
  }

  // --- Production --------------------------------------------------------
  const p = ctx.production;
  if (p?.isBehindSchedule) {
    const detail =
      p.slipDays != null && p.slipDays > 0
        ? `At ${fmtQty(p.dailyRate)}/day the order finishes ${p.slipDays} day${p.slipDays === 1 ? '' : 's'} after the required date. ${fmtQty(p.requiredDailyRate)}/day is needed.`
        : `${fmtQty(p.remainingQty)} pieces remain with no time left before the required date.`;
    push({
      code: AlertCode.PRODUCTION_BEHIND, severity: AlertSeverity.CRITICAL,
      title: 'Production behind schedule', detail,
      nextAction: 'Add a line or overtime, or renegotiate the delivery date',
      tab: 'production',
    });
  }

  // --- Quality -----------------------------------------------------------
  for (const q of ctx.quality ?? []) {
    if (q.result === 'FAIL' && !q.correctiveActionClosed) {
      push({
        code: AlertCode.QUALITY_FAILED, severity: AlertSeverity.CRITICAL,
        title: 'Quality audit failed',
        detail: 'A final inspection failed and the corrective action is still open. The order is blocked.',
        nextAction: 'Complete the corrective action and request re-inspection',
        tab: 'quality', entityId: q.id,
      });
    }
  }

  // --- Tasks -------------------------------------------------------------
  const overdue = ctx.tasks.filter((t) => {
    if (t.status === TaskStatus.COMPLETED || !t.dueDate) return false;
    const d = daysBetween(today, t.dueDate);
    return d != null && d < 0;
  });
  if (overdue.length > 0) {
    const worst = [...overdue].sort(
      (a, b) => (daysBetween(today, a.dueDate) ?? 0) - (daysBetween(today, b.dueDate) ?? 0),
    )[0]!;
    push({
      code: AlertCode.TASK_OVERDUE, severity: AlertSeverity.WARNING,
      title: `${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}`,
      detail: `Oldest: "${worst.title}"${worst.assigneeName ? ` — ${worst.assigneeName}` : ''}${worst.department ? ` (${worst.department})` : ''}.`,
      nextAction: `Follow up with ${worst.assigneeName ?? 'the assignee'}`,
      tab: 'tasks', entityId: worst.id,
    });
  }

  // --- Packing -----------------------------------------------------------
  if (
    ctx.order.producedQty > 0 &&
    ctx.order.packedQty > 0 &&
    ctx.order.packedQty < ctx.order.producedQty &&
    daysToShip != null && daysToShip <= SHIP_WARNING_DAYS
  ) {
    push({
      code: AlertCode.PACKING_INCOMPLETE, severity: AlertSeverity.ATTENTION,
      title: 'Packing incomplete',
      detail: `${fmtQty(ctx.order.producedQty - ctx.order.packedQty)} produced pieces are not yet packed with ${daysToShip} day${daysToShip === 1 ? '' : 's'} to shipping.`,
      nextAction: 'Complete the packing list',
      tab: 'packing',
    });
  }

  return out.sort((a, b) => a.rank - b.rank);
}

export function countBySeverity(alerts: readonly Alert[]): Record<AlertSeverity, number> {
  const out = { CRITICAL: 0, WARNING: 0, ATTENTION: 0, OK: 0 } as Record<AlertSeverity, number>;
  for (const a of alerts) out[a.severity]++;
  return out;
}

export const SEVERITY_STYLE: Record<AlertSeverity, { icon: string; label: string; chip: string; bar: string }> = {
  CRITICAL:  { icon: '🔴', label: 'Critical',  chip: 'bg-red-50 text-red-700 ring-red-600/20',        bar: 'bg-red-500' },
  WARNING:   { icon: '🟠', label: 'Warning',   chip: 'bg-orange-50 text-orange-700 ring-orange-600/20', bar: 'bg-orange-500' },
  ATTENTION: { icon: '🟡', label: 'Attention', chip: 'bg-amber-50 text-amber-800 ring-amber-600/20',  bar: 'bg-amber-400' },
  OK:        { icon: '🟢', label: 'OK',        chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', bar: 'bg-emerald-500' },
};

function humanise(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}
