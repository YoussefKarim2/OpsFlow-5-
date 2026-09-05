/**
 * Who hears about a change — and, separately, who has said they don't want
 * to.
 *
 * Before this file, every tracked change (see change-catalogue.ts) reached
 * every active user in the company. That is what `activeRecipients` in
 * change-service.ts did, and it is the thing this file replaces: a change to
 * a fabric colour and a change that cancels an order produced the same
 * broadcast to the same everyone.
 *
 * The rule now is a fixed table (`DEPARTMENTS_FOR`) from a change's category
 * to the departments that actually own that kind of work, always joined by
 * the order's coordinator and outside-work manager — the two people who are
 * "responsible" for an order by definition, in `Order.coordinatorId` and
 * `Order.outsideWorkManagerId` — and, for URGENT changes only, the admin
 * department and every super admin. `NotificationPreference` (below) is the
 * second, independent filter: a category/priority/channel someone has
 * explicitly turned off.
 */

import type { ChangeCategory, Department, NotificationPriority, NotificationType } from '@opsflow/shared';
import { prisma } from '../db.js';
import { config } from '../config.js';

export interface Recipient {
  id: string;
  email: string;
  name: string;
}

/**
 * Which departments own this kind of change, beyond the order's own
 * coordinator/outside-work manager (who are always included — see
 * `resolveRecipients`). An empty list means "just the people responsible for
 * the order, nobody else by default" — right for TASKS (the assignee is
 * targeted directly at the call site, not broadcast to a department) and for
 * DOCUMENTS (a customer file belongs to whoever runs the order).
 */
const DEPARTMENTS_FOR: Record<ChangeCategory, Department[]> = {
  ORDER: ['PRODUCTION_MANAGER'],
  PRODUCTION: ['PRODUCTION_MANAGER'],
  INVENTORY: ['WAREHOUSE'],
  MATERIALS: ['WAREHOUSE'],
  TASKS: [],
  QUALITY: ['QUALITY'],
  SHIPMENT: ['PACKING'],
  APPROVALS: [],
  DOCUMENTS: [],
  ADMIN: ['ADMIN'],
};

const PRIORITY_RANK: Record<NotificationPriority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };

export interface RouteInput {
  category: ChangeCategory;
  priority: NotificationPriority;
  /** The order's `coordinatorId`, if this change belongs to an order. */
  coordinatorId?: string | null;
  /** The order's `outsideWorkManagerId`, if this change belongs to an order. */
  outsideWorkManagerId?: string | null;
  /**
   * Specific people who must hear about this one change regardless of
   * category or department — a task's assignee, most notably. The category
   * table has no department for TASKS precisely because "everyone in some
   * department" is the wrong answer for "you were assigned this"; the right
   * answer is a specific person, supplied here by the caller.
   */
  extraUserIds?: ReadonlyArray<string | null | undefined>;
  actorId: string | null;
}

/**
 * The raw recipient set for one change — before `filterByPreference` removes
 * anyone who has turned this category, priority or channel off.
 *
 * Never includes the actor unless `NOTIFY_ACTOR=true`: telling someone what
 * they just did trains them to ignore OpsFlow mail, which is how the message
 * that matters gets missed too. De-duplicated by construction (a `Set` of
 * ids), so a production manager who is also the coordinator is not emailed
 * twice.
 */
export async function resolveRecipients(input: RouteInput): Promise<Recipient[]> {
  const departments = DEPARTMENTS_FOR[input.category];
  const responsibleIds = [
    input.coordinatorId, input.outsideWorkManagerId, ...(input.extraUserIds ?? []),
  ].filter((id): id is string => !!id);

  const or: Array<Record<string, unknown>> = [];
  if (departments.length > 0) or.push({ department: { in: departments } });
  if (responsibleIds.length > 0) or.push({ id: { in: responsibleIds } });
  if (input.priority === 'URGENT') or.push({ department: 'ADMIN' }, { isSuperAdmin: true });

  // `NOTIFY_ACTOR` says the person who made the change is told about it too,
  // so when it is on the actor is *added* to the set rather than merely not
  // subtracted from it. Removing the exclusion alone was not the same thing:
  // it only helped an actor who already qualified through their department or
  // through owning the order, and a coordinator editing somebody else's order
  // qualifies through neither. That is exactly the person who turns the
  // setting on, makes a change, and concludes the email is broken.
  if (config.NOTIFY_ACTOR && input.actorId) or.push({ id: input.actorId });

  if (or.length === 0) return [];

  const users = await prisma.user.findMany({
    where: {
      active: true,
      OR: or,
      ...(config.NOTIFY_ACTOR || !input.actorId ? {} : { id: { not: input.actorId } }),
    },
    select: { id: true, email: true, name: true },
  });
  return users;
}

/**
 * Remove anyone who has told OpsFlow they don't want this.
 *
 * A user with no `NotificationPreference` row for this category is on by
 * default at every priority, on both channels — the point of a default is
 * that a brand-new account is never silently under-notified because it
 * never visited the settings page.
 */
export async function filterByPreference(
  recipients: readonly Recipient[],
  category: ChangeCategory,
  priority: NotificationPriority,
  channel: 'email' | 'inApp',
): Promise<Recipient[]> {
  if (recipients.length === 0) return [];

  const prefs = await prisma.notificationPreference.findMany({
    where: { userId: { in: recipients.map((r) => r.id) }, category },
  });
  const byUser = new Map(prefs.map((p) => [p.userId, p]));

  return recipients.filter((r) => {
    const pref = byUser.get(r.id);
    if (!pref) return true;
    if (channel === 'email' && !pref.email) return false;
    if (channel === 'inApp' && !pref.inApp) return false;
    return PRIORITY_RANK[priority] >= PRIORITY_RANK[pref.minPriority as NotificationPriority];
  });
}

/**
 * A real `NotificationType` per category, so the bell can group and icon
 * notifications meaningfully instead of every row reading "Mentioned".
 * A call site that knows more than the category alone (task assignment,
 * the alert sweep) passes its own type instead of calling this.
 */
export function mapCategoryToNotificationType(category: ChangeCategory): NotificationType {
  switch (category) {
    case 'ORDER': return 'ORDER_UPDATED';
    case 'PRODUCTION': return 'PRODUCTION_UPDATED';
    case 'TASKS': return 'TASK_ASSIGNED';
    case 'QUALITY': return 'QUALITY_UPDATED';
    case 'SHIPMENT': return 'SHIPMENT_READY';
    case 'APPROVALS': return 'APPROVAL_REQUESTED';
    case 'MATERIALS':
    case 'INVENTORY':
      return 'MATERIAL_UPDATED';
    case 'DOCUMENTS':
    case 'ADMIN':
    default:
      return 'SYSTEM_UPDATE';
  }
}
