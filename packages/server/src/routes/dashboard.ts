/**
 * Dashboard and Follow-Up Centre.
 *
 * The Follow-Up endpoint is, in the brief's own words, one of the most
 * important parts of the application: every open action across every order,
 * ranked by urgency. It is assembled from the same alert engine and the same
 * derived state the order workspace uses, so a coordinator can never see an
 * item here that the order page disagrees with.
 */

import { Router } from 'express';
import {
  OrderStatus, QtyLedger, evaluateAlerts, daysBetween, DEPARTMENT_LABEL,
  type FollowUpItemDto, type Priority,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { ORDER_INCLUDE, buildOrderSummary, deriveOrder } from '../services/order-service.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

const DUE_SOON_DAYS = 14;

dashboardRouter.get('/', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const today = new Date();

  const orders = await prisma.order.findMany({
    where: { cancelled: false },
    include: ORDER_INCLUDE,
  });

  const summaries = orders.map((o) => buildOrderSummary(o, today));

  const cards = {
    totalActive: summaries.filter(
      (s) => s.status !== OrderStatus.COMPLETED && s.status !== OrderStatus.CANCELLED,
    ).length,
    dueSoon: summaries.filter(
      (s) => s.daysRemaining != null && s.daysRemaining >= 0 && s.daysRemaining <= DUE_SOON_DAYS &&
        s.status !== OrderStatus.COMPLETED && s.status !== OrderStatus.SHIPPED,
    ).length,
    late: summaries.filter(
      (s) => (s.daysRemaining != null && s.daysRemaining < 0 && s.status !== OrderStatus.COMPLETED && s.status !== OrderStatus.SHIPPED) ||
        s.status === OrderStatus.PRODUCTION_DELAYED,
    ).length,
    waitingApproval: summaries.filter((s) => s.status === OrderStatus.WAITING_APPROVAL).length,
    inProduction: summaries.filter(
      (s) => s.status === OrderStatus.IN_PRODUCTION || s.status === OrderStatus.PRODUCTION_DELAYED,
    ).length,
    // §25's triage: the three numbers a coordinator needs before anything else.
    blocked: summaries.filter((s) => s.blockerCount > 0).length,
    atRisk: summaries.filter(
      (s) => s.blockerCount === 0 && (s.health === 'LATE' || s.alertCounts.critical > 0 || s.alertCounts.warning > 0),
    ).length,
    onTrack: summaries.filter(
      (s) => s.blockerCount === 0 && s.alertCounts.critical === 0 && s.alertCounts.warning === 0 &&
        s.status !== OrderStatus.COMPLETED && s.status !== OrderStatus.CANCELLED,
    ).length,
    materialShortages: summaries.filter((s) => s.materialShortCount > 0).length,
    waitingMaterials: 0, // filled below from BOM state
    waitingExternal: 0,
    waitingQuality: summaries.filter(
      (s) => s.status === OrderStatus.QUALITY_CHECK || s.status === OrderStatus.QUALITY_BLOCKED,
    ).length,
    readyForPacking: summaries.filter(
      (s) => s.status === OrderStatus.PACKING ||
        (s.producedQty > 0 && s.packedQty < s.producedQty && s.status !== OrderStatus.SHIPPED),
    ).length,
    readyToShip: summaries.filter((s) => s.status === OrderStatus.READY_TO_SHIP).length,
  };

  /**
   * "Your Action Items" — the brief's §25.
   *
   * One row per *thing to do*, not per order, because "PO-192 has problems" is
   * not an action and "PO-192 is 476 m short of Rosetta White — raise a
   * purchase request" is. Each carries where to go and what to press, and the
   * coordinator's own orders sort above everyone else's.
   */
  const actionItems: Array<{
    id: string; orderId: string; poNumber: string; orderName: string;
    severity: 'CRITICAL' | 'WARNING' | 'ATTENTION';
    title: string; detail: string; actionLabel: string; tab: string;
    mine: boolean; daysRemaining: number | null;
  }> = [];

  for (const o of orders) {
    const d = deriveOrder(o, today);
    if (d.bom && !d.bom.fullyIssued && d.status !== OrderStatus.COMPLETED) cards.waitingMaterials++;
    if (o.externalOperations.some((op) => op.status !== 'RETURNED' && op.status !== 'CANCELLED')) {
      cards.waitingExternal++;
    }

    const mine = o.coordinatorId === actor.id;

    for (const b of d.blockers) {
      actionItems.push({
        id: `${o.id}:${b.key}`,
        orderId: o.id, poNumber: o.poNumber, orderName: o.orderName,
        severity: 'CRITICAL',
        title: `${b.stageLabel} blocked — ${b.requirement}`,
        detail: b.detail,
        actionLabel: b.actionLabel ?? 'Review',
        tab: b.tab ?? 'overview',
        mine,
        daysRemaining: d.daysRemaining,
      });
    }

    // Alerts that are not already covered by a blocker, so the same problem is
    // not listed twice under two names.
    const blockerTabs = new Set(d.blockers.map((b) => b.tab));
    for (const a of d.alerts) {
      if (a.severity === 'OK') continue;
      if (a.tab && blockerTabs.has(a.tab)) continue;
      actionItems.push({
        id: `${o.id}:${a.code}:${a.entityId ?? ''}`,
        orderId: o.id, poNumber: o.poNumber, orderName: o.orderName,
        severity: a.severity as 'CRITICAL' | 'WARNING' | 'ATTENTION',
        title: a.title,
        detail: a.detail,
        actionLabel: a.nextAction,
        tab: a.tab ?? 'overview',
        mine,
        daysRemaining: d.daysRemaining,
      });
    }
  }

  const severityRank = { CRITICAL: 0, WARNING: 1, ATTENTION: 2 };
  actionItems.sort((a, b) => {
    // Your own orders first: a coordinator is accountable for theirs before
    // they are useful on anyone else's.
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    if (severityRank[a.severity] !== severityRank[b.severity]) {
      return severityRank[a.severity] - severityRank[b.severity];
    }
    return (a.daysRemaining ?? 9999) - (b.daysRemaining ?? 9999);
  });

  // "Requiring attention": anything with an alert, late, or delayed. Ranked so
  // the worst thing in the factory is the first row on the page.
  const attention = summaries
    .filter(
      (s) =>
        s.alertCounts.critical > 0 || s.alertCounts.warning > 0 ||
        (s.daysRemaining != null && s.daysRemaining < 7) ||
        s.status === OrderStatus.PRODUCTION_DELAYED || s.status === OrderStatus.QUALITY_BLOCKED,
    )
    .sort((a, b) => {
      if (b.alertCounts.critical !== a.alertCounts.critical) return b.alertCounts.critical - a.alertCounts.critical;
      if (b.alertCounts.warning !== a.alertCounts.warning) return b.alertCounts.warning - a.alertCounts.warning;
      return (a.daysRemaining ?? 9999) - (b.daysRemaining ?? 9999);
    })
    .slice(0, 20);

  const [myTasks, recentActivity] = await Promise.all([
    prisma.task.findMany({
      where: {
        order: { cancelled: false },
        status: { not: 'COMPLETED' },
        OR: [{ assigneeId: actor.id }, { assigneeId: null, department: actor.department as never }],
      },
      include: {
        assignee: true, completedBy: true,
        order: { select: { id: true, poNumber: true, orderName: true } },
        _count: { select: { comments: true, attachments: true } },
      },
      orderBy: [{ dueDate: 'asc' }],
      take: 10,
    }),
    prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 15 }),
  ]);

  // Production trend across the whole factory, last 14 days.
  const since = new Date(today.getTime() - 14 * 86_400_000);
  const production = await prisma.productionRecord.findMany({
    where: { date: { gte: since }, operation: 'SEWING' },
    select: { date: true, qty: true },
  });
  const trendMap = new Map<string, number>();
  for (const p of production) {
    const k = p.date.toISOString().slice(0, 10);
    trendMap.set(k, (trendMap.get(k) ?? 0) + p.qty);
  }

  const statusMap = new Map<string, number>();
  for (const s of summaries) statusMap.set(s.status, (statusMap.get(s.status) ?? 0) + 1);

  res.json({
    cards,
    actionItems: actionItems.slice(0, 25),
    actionItemCounts: {
      total: actionItems.length,
      mine: actionItems.filter((i) => i.mine).length,
      critical: actionItems.filter((i) => i.severity === 'CRITICAL').length,
    },
    ordersRequiringAttention: attention,
    myOpenTasks: myTasks.map((t) => ({
      id: t.id,
      orderId: t.order.id,
      orderPoNumber: t.order.poNumber,
      orderName: t.order.orderName,
      stageKey: t.stageKey,
      title: t.title,
      department: t.department,
      departmentLabel: DEPARTMENT_LABEL[t.department].en,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate?.toISOString() ?? null,
      daysRemaining: t.dueDate ? daysBetween(today, t.dueDate) : null,
      isOverdue: !!t.dueDate && (daysBetween(today, t.dueDate) ?? 0) < 0,
    })),
    recentActivity: recentActivity.map((l) => ({
      id: l.id, orderId: l.orderId, actorName: l.actorName,
      actorInitials: l.actorName.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase(),
      action: l.action, summary: l.summary, createdAt: l.createdAt.toISOString(),
    })),
    productionTrend: [...trendMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, qty]) => ({ date, qty })),
    statusBreakdown: [...statusMap.entries()].map(([status, count]) => ({ status, count })),
  });
}));

/**
 * The Follow-Up Centre — section 20.
 *
 * Every open action in the factory, flattened into one ranked list: overdue
 * tasks, pending approvals, material shortages, late external operations and
 * open quality failures. Nothing here is a new calculation; it is the alert
 * engine plus the task list, projected into one shape.
 */
dashboardRouter.get('/follow-up', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const today = new Date();
  const mineOnly = req.query.mine === 'true';

  const orders = await prisma.order.findMany({
    where: {
      cancelled: false,
      ...(mineOnly ? { coordinatorId: actor.id } : {}),
    },
    include: ORDER_INCLUDE,
  });

  const items: FollowUpItemDto[] = [];

  for (const order of orders) {
    const d = deriveOrder(order, today);

    // Alerts already carry severity and a next action — reuse them verbatim
    // rather than re-deriving urgency here.
    for (const alert of d.alerts) {
      items.push({
        id: `${order.id}:${alert.code}:${alert.entityId ?? ''}`,
        kind:
          alert.code === 'APPROVAL_PENDING' ? 'APPROVAL'
          : alert.code === 'MATERIAL_SHORTAGE' ? 'SHORTAGE'
          : alert.code.startsWith('EXTERNAL') ? 'EXTERNAL'
          : alert.code === 'QUALITY_FAILED' ? 'QUALITY'
          : 'TASK',
        orderId: order.id,
        orderPoNumber: order.poNumber,
        orderName: order.orderName,
        title: alert.title,
        detail: alert.detail,
        responsibleName: order.coordinator?.name ?? null,
        department: null,
        dueDate: order.requiredDeliveryDate?.toISOString() ?? null,
        daysRemaining: d.daysRemaining,
        priority:
          (alert.severity === 'CRITICAL' ? 'URGENT'
          : alert.severity === 'WARNING' ? 'HIGH'
          : 'MEDIUM') as Priority,
        severity: alert.severity as FollowUpItemDto['severity'],
        nextAction: alert.nextAction,
        tab: alert.tab ?? null,
      });
    }

    // Individually actionable overdue tasks, so the coordinator can chase a
    // person rather than a category.
    for (const t of order.tasks) {
      if (t.status === 'COMPLETED' || !t.dueDate) continue;
      const remaining = daysBetween(today, t.dueDate);
      if (remaining == null || remaining > 0) continue;
      items.push({
        id: `task:${t.id}`,
        kind: 'TASK',
        orderId: order.id,
        orderPoNumber: order.poNumber,
        orderName: order.orderName,
        title: t.title,
        detail: `${Math.abs(remaining)} day${Math.abs(remaining) === 1 ? '' : 's'} overdue · ${DEPARTMENT_LABEL[t.department].en}`,
        responsibleName: t.assignee?.name ?? null,
        department: DEPARTMENT_LABEL[t.department].en,
        dueDate: t.dueDate.toISOString(),
        daysRemaining: remaining,
        priority: t.priority,
        severity: remaining < -3 ? 'CRITICAL' : 'WARNING',
        nextAction: `Follow up with ${t.assignee?.name ?? DEPARTMENT_LABEL[t.department].en}`,
        tab: 'tasks',
      });
    }
  }

  const rank = { CRITICAL: 0, WARNING: 1, ATTENTION: 2, OK: 3 };
  items.sort((a, b) => {
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    return (a.daysRemaining ?? 9999) - (b.daysRemaining ?? 9999);
  });

  res.json({
    data: items,
    counts: {
      critical: items.filter((i) => i.severity === 'CRITICAL').length,
      warning: items.filter((i) => i.severity === 'WARNING').length,
      attention: items.filter((i) => i.severity === 'ATTENTION').length,
    },
  });
}));

// ── Notifications ───────────────────────────────────────────────────────────

dashboardRouter.get('/notifications', asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const [notifications, unreadCount, byPriority] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: actor.id },
      include: { order: { select: { poNumber: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.notification.count({ where: { userId: actor.id, readAt: null } }),
    prisma.notification.groupBy({
      by: ['priority'],
      where: { userId: actor.id, readAt: null },
      _count: { _all: true },
    }),
  ]);

  const unreadByPriority = Object.fromEntries(
    byPriority.map((p) => [p.priority, p._count._all]),
  );

  res.json({
    data: notifications.map((n) => ({
      id: n.id, type: n.type, title: n.title, body: n.body,
      priority: n.priority,
      orderId: n.orderId, orderPoNumber: n.order?.poNumber ?? null,
      changeEventId: n.changeEventId,
      link: n.link, readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
    unreadCount,
    // Counted separately from the page above: a bell showing "12" when there
    // are ninety unread is worse than no badge, because it looks precise.
    unreadByPriority,
  });
}));

dashboardRouter.post('/notifications/:id/read', asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  await prisma.notification.updateMany({
    where: { id: req.params.id, userId: actor.id },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
}));

dashboardRouter.post('/notifications/read-all', asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  await prisma.notification.updateMany({
    where: { userId: actor.id, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
}));
