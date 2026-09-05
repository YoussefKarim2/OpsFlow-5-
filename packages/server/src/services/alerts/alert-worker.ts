/**
 * The alert sweep — deadlines, overdue orders and material shortages,
 * turned into notifications.
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
import { ORDER_INCLUDE, deriveOrder } from '../order-service.js';
import { announceChange } from '../change-service.js';

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

/** A stable, id-safe fallback discriminator for an alert with no entityId of its own. */
function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
}

/**
 * One pass over every open order: recompute its alerts, and announce the
 * ones that are new or have materially changed since the last sweep.
 *
 * "Materially changed" is a plain string comparison of severity + detail —
 * `deriveOrder`'s `detail` text already carries the number that moved ("3
 * days remaining" vs "overdue by 2 days"), so a snapshot changing means the
 * situation genuinely did, not that the sweep merely ran again.
 */
export async function runAlertSweep(): Promise<{ checked: number; announced: number }> {
  const orders = await prisma.order.findMany({
    where: { cancelled: false, cachedStatus: { notIn: ['COMPLETED'] } },
    include: ORDER_INCLUDE,
  });

  let announced = 0;
  const today = new Date();

  for (const order of orders) {
    const { alerts } = deriveOrder(order, today);

    for (const alert of alerts) {
      const priority = SEVERITY_PRIORITY[alert.severity];
      if (!priority) continue;

      // `deriveOrder` can return several alerts sharing one `code` within the
      // same order with no `entityId` of their own — several blocked stages,
      // several materials with a consumption variance — each still uniquely
      // identified by its own `title` ("Cutting is blocked" vs "Packing is
      // blocked"). Falling back to `order.id` alone for all of them made
      // every alert in such a group fight over one dedup row, each sweep
      // overwriting the last one's snapshot and re-triggering the others:
      // verified live against real order data, fixed by keying on the title
      // too whenever there is no better id.
      const entityId = alert.entityId ?? `${order.id}:${slug(alert.title)}`;
      const snapshot = `${alert.severity}:${alert.detail}`;

      const prior = await prisma.alertState.findUnique({
        where: { code_entityType_entityId: { code: alert.code, entityType: 'Order', entityId } },
      });
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
  }

  return { checked: orders.length, announced };
}

let timer: NodeJS.Timeout | null = null;

export function startAlertWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runAlertSweep().catch((err: unknown) => {
      console.error('ALERT SWEEP FAILED (will retry next interval):', err);
    });
  }, config.ALERT_SWEEP_INTERVAL_SECONDS * 1000);
  // Never hold the process open for the sake of the sweep timer.
  timer.unref();
}

export function stopAlertWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
