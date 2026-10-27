/**
 * The alert sweep — deadlines, overdue orders and material shortages,
 * turned into in-app notifications. Never email: `announceChange` mails only
 * what a person did, and the sweep announces as nobody.
 *
 * Nothing here computes urgency itself. `evaluateAlerts()` (via
 * `deriveOrder()`) already does that for the Follow-Up Centre, and repeating
 * that logic here would be the one thing this file exists to avoid: a second
 * definition of "overdue" that could quietly disagree with the first. This
 * file's entire job is turning that existing, already-correct computation
 * into an announcement the first time it's true, and again only if it gets
 * materially worse — never once per sweep, forever, which is how a genuinely
 * important alert turns into the message everyone has learned to ignore.
 *
 * Mirrors `email-queue.ts`'s worker shape exactly: a module-level, unref'd
 * `setInterval`, started from `index.ts` and never from `app.ts`, so
 * building an app for a test never starts a background timer.
 */

import { ChangeCategory, NotificationPriority, type AlertSeverity } from '@opsflow/shared';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { ORDER_INCLUDE, deriveOrder, type FullOrder } from '../order-service.js';
import { announceChange } from '../change-service.js';
import { alertSnapshot, alertEntityId, alertKey, staleAlertStateIds } from './alert-policy.js';

const SEVERITY_PRIORITY: Record<AlertSeverity, NotificationPriority | null> = {
  CRITICAL: NotificationPriority.URGENT,
  WARNING: NotificationPriority.HIGH,
  ATTENTION: NotificationPriority.NORMAL,
  // Nothing wrong — not an alert worth a message.
  OK: null,
};

/**
 * Every alert code the Follow-Up Centre can produce maps to a ChangeCategory
 * so it routes through the same department/coordinator rules as everything
 * else (see notification-routing.ts) — a material shortage reaches the
 * warehouse, not the whole company.
 */
function categoryForAlertCode(code: string): ChangeCategory {
  if (code === 'MATERIAL_SHORTAGE' || code === 'MATERIAL_UNRESERVED') return ChangeCategory.MATERIALS;
  if (code === 'TASK_OVERDUE') return ChangeCategory.TASKS;
  if (code === 'QUALITY_FAILED') return ChangeCategory.QUALITY;
  if (code === 'PACKING_INCOMPLETE' || code === 'SHIP_DATE_APPROACHING') return ChangeCategory.SHIPMENT;
  if (code === 'APPROVAL_PENDING') return ChangeCategory.APPROVALS;
  return ChangeCategory.ORDER;
}

/**
 * Orders per page. The whole open book with every relation used to be loaded
 * in one query and held for the length of the sweep; a page at a time keeps
 * the memory flat as the book grows.
 */
const PAGE_SIZE = 50;

/**
 * One pass over every open order: recompute its alerts, and announce the
 * ones that are new or have materially changed since the last sweep.
 *
 * "Materially changed" is decided by `alertSnapshot` (alert-policy.ts): for most
 * alerts a change in severity or detail, but for lateness and deadline
 * reminders only a change in severity — their detail is a day count that
 * moves every day by itself, which re-announced every late item each morning.
 *
 * Shipped orders are left out along with completed ones: the goods have gone,
 * and the alert engine has nothing left to say about their schedule.
 */
export async function runAlertSweep(): Promise<{ checked: number; announced: number }> {
  let checked = 0;
  let announced = 0;
  const today = new Date();
  let after: string | null = null;

  for (;;) {
    // Keyed on the id rather than an offset, so an order that ships or is
    // cancelled mid-sweep does not shift the pages and skip another.
    const orders: FullOrder[] = await prisma.order.findMany({
      where: {
        cancelled: false,
        cachedStatus: { notIn: ['COMPLETED', 'SHIPPED'] },
        ...(after ? { id: { gt: after } } : {}),
      },
      include: ORDER_INCLUDE,
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
    });
    if (orders.length === 0) break;
    checked += orders.length;
    announced += await sweepPage(orders, today);
    if (orders.length < PAGE_SIZE) break;
    after = orders[orders.length - 1]!.id;
  }

  return { checked, announced };
}

/** Announce one page of orders' alerts. Returns how many were announced. */
async function sweepPage(orders: FullOrder[], today: Date): Promise<number> {
  // Each order's own records — the ids its alerts may be kept against.
  const ownIds = new Map(orders.map((o) => [o.id, new Set<string>([
    ...o.externalOperations.map((r) => r.id),
    ...o.qualityAudits.map((r) => r.id),
    ...o.tasks.map((r) => r.id),
  ])]));

  // The page's dedup rows in one query, rather than one per alert.
  const states = await prisma.alertState.findMany({
    where: {
      entityType: 'Order',
      OR: [
        { entityId: { in: [...ownIds.values()].flatMap((s) => [...s]) } },
        ...orders.map((o) => ({ entityId: { startsWith: `${o.id}:` } })),
      ],
    },
    select: { id: true, code: true, entityId: true, lastSnapshot: true },
  });
  const stateByKey = new Map(states.map((s) => [alertKey(s.code, s.entityId), s]));

  let announced = 0;
  const stale: string[] = [];

  for (const order of orders) {
    const { alerts } = deriveOrder(order, today);
    const fired = new Set<string>();

    for (const alert of alerts) {
      const priority = SEVERITY_PRIORITY[alert.severity];
      if (!priority) continue;

      const entityId = alertEntityId(order.id, alert);
      const snapshot = alertSnapshot(alert);
      fired.add(alertKey(alert.code, entityId));

      const prior = stateByKey.get(alertKey(alert.code, entityId));
      if (prior?.lastSnapshot === snapshot) continue;

      await announceChange({
        entityType: 'Order',
        entityId,
        action: 'UPDATE',
        category: categoryForAlertCode(alert.code),
        summary: `PO ${order.poNumber}: ${alert.title}`,
        subject: `PO ${order.poNumber}`,
        priority,
        orderId: order.id,
        link: alert.tab ? `/orders/${order.id}?tab=${alert.tab}` : `/orders/${order.id}`,
        fields: [{ label: alert.title, oldValue: prior?.lastSnapshot ?? null, newValue: alert.detail }],
        actorId: null,
        actorName: 'OpsFlow',
      });

      await prisma.alertState.upsert({
        where: { code_entityType_entityId: { code: alert.code, entityType: 'Order', entityId } },
        create: { code: alert.code, entityType: 'Order', entityId, lastSnapshot: snapshot },
        update: { lastSnapshot: snapshot, lastNotifiedAt: new Date() },
      });
      announced++;
    }

    stale.push(...staleAlertStateIds(order.id, ownIds.get(order.id)!, states, fired));
  }

  // An alert that stopped firing is forgotten, so if it comes back it is news
  // again rather than matched against the snapshot it left behind.
  if (stale.length > 0) await prisma.alertState.deleteMany({ where: { id: { in: stale } } });

  return announced;
}

let timer: NodeJS.Timeout | null = null;
let sweeping = false;

export function startAlertWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    // One sweep at a time: a slow sweep on a big order book must not have the
    // next one start on top of it and double the memory and the announcements.
    if (sweeping) return;
    sweeping = true;
    void runAlertSweep().catch((err: unknown) => {
      console.error('ALERT SWEEP FAILED (will retry next interval):', err);
    }).finally(() => { sweeping = false; });
  }, config.ALERT_SWEEP_INTERVAL_SECONDS * 1000);
  // Never hold the process open for the sake of the sweep timer.
  timer.unref();
}

export function stopAlertWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
