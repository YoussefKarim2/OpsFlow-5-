/**
 * Activity log and notifications — the brief's sections 27 and 28.
 *
 * The activity feed is written explicitly (unlike the field-level audit trail,
 * which is automatic middleware) because a good feed entry is a human sentence,
 * not a field diff. "Warehouse issued 500 poly bags" is useful;
 * "bom_items.issuedQty 0 → 500" is not.
 */

import type { Prisma, PrismaClient, NotificationType, Department } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface LogInput {
  orderId?: string | null;
  actorId?: string | null;
  actorName: string;
  action: string;
  summary: string;
  entityType?: string | null;
  entityId?: string | null;
  meta?: Prisma.InputJsonValue;
}

export async function logActivity(input: LogInput, db: Db = defaultPrisma): Promise<void> {
  await db.activityLog.create({
    data: {
      orderId: input.orderId ?? null,
      actorId: input.actorId ?? null,
      actorName: input.actorName,
      action: input.action,
      summary: input.summary,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      meta: input.meta,
    },
  });
}

export interface NotifyInput {
  userIds: string[];
  orderId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
}

export async function notify(input: NotifyInput, db: Db = defaultPrisma): Promise<void> {
  const unique = [...new Set(input.userIds)].filter(Boolean);
  if (unique.length === 0) return;
  await db.notification.createMany({
    data: unique.map((userId) => ({
      userId,
      orderId: input.orderId ?? null,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    })),
  });
}

/**
 * Resolve who should hear about something on an order.
 *
 * The coordinator always hears about it — they own the order, and the brief is
 * clear that they are the one person who must never be surprised. Beyond that,
 * the department that has to act.
 */
export async function recipientsFor(
  orderId: string,
  departments: Department[] = [],
  db: Db = defaultPrisma,
): Promise<string[]> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { coordinatorId: true, outsideWorkManagerId: true },
  });

  const ids: string[] = [];
  if (order?.coordinatorId) ids.push(order.coordinatorId);

  if (departments.length > 0) {
    const users = await db.user.findMany({
      where: { department: { in: departments }, active: true },
      select: { id: true },
    });
    ids.push(...users.map((u) => u.id));
  }

  return [...new Set(ids)];
}

/** Convenience: log an activity and notify the right people in one call. */
export async function logAndNotify(
  log: LogInput,
  notification: Omit<NotifyInput, 'userIds'> & { departments?: Department[] },
  db: Db = defaultPrisma,
): Promise<void> {
  await logActivity(log, db);
  if (!log.orderId) return;
  const userIds = await recipientsFor(log.orderId, notification.departments ?? [], db);
  // Don't notify someone about their own action.
  const filtered = userIds.filter((id) => id !== log.actorId);
  await notify({ ...notification, userIds: filtered, orderId: log.orderId }, db);
}
