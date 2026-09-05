/**
 * Turning a request's collected changes into one announcement.
 *
 * This runs **after** the response has already gone to the client. Nothing here
 * is on the critical path: by the time it starts, the order is saved, the audit
 * trail is written, and the person who made the change has their answer. That
 * ordering is the whole of requirement §19 — an email that cannot be sent must
 * never be able to undo a change that was.
 *
 * What it does, in order:
 *
 *   1. Fold the request's drafts into one change per record — three edited
 *      columns on one order are one event, not three.
 *   2. Write the ChangeEvent and its labelled before/after fields.
 *   3. Work out who is actually responsible for this kind of change on this
 *      order (see notification-routing.ts), then narrow that by anyone's
 *      own notification preferences.
 *   4. Create an in-app notification for the resulting in-app recipients.
 *   5. Queue one email to the (possibly different) email recipients.
 *
 * Steps 2–5 each guard their own failure. A failed email leaves the event and
 * the notifications in place; a failed notification leaves the event in place;
 * a failed event leaves the audit trail in place, because that was written
 * during the request by different code.
 */

import {
  TRACKED_MODELS, NotificationPriority, ChangeCategory,
  formatValue, derivePriority, summariseChange, describeFieldChange,
  type NotificationType,
} from '@opsflow/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { ALWAYS_NOTIFY_EMAILS } from '../config.js';
import type { RequestContext } from '../request-context.js';
import { foldChanges, buildLink, type FoldedChange } from './change-fold.js';
import { renderChangeEmail } from './email/template.js';
import { enqueueEmail } from './email/email-queue.js';
import { resolveRecipients, filterByPreference, mapCategoryToNotificationType } from './notification-routing.js';

// ─────────────────────────────────────────────────────────────────────────────
// The flush
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Announce everything one request changed.
 *
 * Fire-and-forget by design: the caller is an Express `finish` listener, and
 * awaiting this would keep a socket's handler alive for the sake of an email.
 */
export function flushChanges(ctx: RequestContext): void {
  const folded = foldChanges(ctx.changes);
  if (folded.length === 0) return;

  void recordChanges(folded, ctx).catch((err: unknown) => {
    console.error('CHANGE ANNOUNCEMENT FAILED — the change itself was saved:', err);
  });
}

async function recordChanges(folded: FoldedChange[], ctx: RequestContext): Promise<void> {
  // Order PO numbers and who's responsible, so an event can say "PO 13506"
  // rather than a cuid, and so routing knows who that order's coordinator
  // and outside-work manager are.
  const orderIds = [...new Set(folded.map((f) => f.orderId).filter((x): x is string => !!x))];
  const orders = orderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, poNumber: true, orderName: true, coordinatorId: true, outsideWorkManagerId: true },
      })
    : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));

  // A task's assignee is the point of a task-assignment notification — the
  // TASKS category has no department in notification-routing.ts precisely
  // because "the assignee", not "everyone in some department", is correct.
  const taskIds = [...new Set(folded.filter((f) => f.model === 'Task').map((f) => f.entityId))];
  const tasks = taskIds.length
    ? await prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, assigneeId: true } })
    : [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  for (const change of folded) {
    const order = change.orderId ? orderById.get(change.orderId) : undefined;
    const subject = order ? `PO ${order.poNumber}` : change.subjectHint;
    const tracked = TRACKED_MODELS[change.model];
    const category = tracked?.category ?? ChangeCategory.ORDER;
    const priority = derivePriority(change.model, change.action, change.fields);
    const summary = summariseChange({
      model: change.model, action: change.action, subject, fields: change.fields,
    });
    const link = buildLink(change.model, change.orderId);

    const raw = await resolveRecipients({
      category, priority,
      coordinatorId: order?.coordinatorId, outsideWorkManagerId: order?.outsideWorkManagerId,
      extraUserIds: change.model === 'Task' ? [taskById.get(change.entityId)?.assigneeId] : undefined,
      actorId: ctx.userId,
    });

    let event;
    try {
      event = await prisma.changeEvent.create({
        data: {
          entityType: change.model,
          entityId: change.entityId,
          action: change.action,
          category: category as never,
          subject,
          summary,
          priority: priority as never,
          orderId: change.orderId,
          actorId: ctx.userId,
          actorName: ctx.userName,
          link,
          reason: ctx.reason,
          fields: {
            create: change.fields.map((f, i) => ({
              field: f.field,
              label: f.label,
              // Formatted here, once, so the timeline, the notification and the
              // email cannot disagree about what "5 September" means.
              oldValue: formatValue(f.oldValue),
              newValue: formatValue(f.newValue),
              position: i,
            })),
          },
        },
        include: { fields: { orderBy: { position: 'asc' } } },
      });
    } catch (err) {
      console.error('CHANGE EVENT WRITE FAILED:', err);
      continue;
    }

    const detail = change.fields.map(describeFieldChange).join(' · ') || null;
    const notificationType = mapCategoryToNotificationType(category);

    const inAppRecipients = await filterByPreference(raw, category, priority, 'inApp');
    if (inAppRecipients.length > 0) {
      try {
        await prisma.notification.createMany({
          data: inAppRecipients.map((r) => ({
            userId: r.id,
            orderId: change.orderId,
            changeEventId: event.id,
            type: notificationType as never,
            priority: priority as never,
            title: summary,
            body: detail,
            link,
          })),
        });
      } catch (err) {
        console.error('NOTIFICATION WRITE FAILED:', err);
      }
    }

    const emailRecipients = await filterByPreference(raw, category, priority, 'email');
    // Called even when nobody is routed: `ALWAYS_NOTIFY_EMAILS` is added inside
    // `queueEmail`, and a change with no departmental owner is exactly the kind
    // the people copied on everything are there to catch. `queueEmail` returns
    // without queuing anything when both lists are empty.
    {
      // Only now, and never awaited by anything the user is waiting on.
      queueEmail(event.id, {
        summary, subject, priority, detail,
        actorName: ctx.userName,
        when: event.createdAt,
        orderLabel: order ? `PO ${order.poNumber} — ${order.orderName}` : subject,
        link,
        fields: event.fields.map((f) => ({
          label: f.label, oldValue: f.oldValue, newValue: f.newValue,
        })),
        recipients: emailRecipients.map((r) => r.email),
      });
    }
  }
}

interface EmailInput {
  summary: string;
  subject: string | null;
  priority: NotificationPriority;
  detail: string | null;
  actorName: string;
  when: Date;
  orderLabel: string | null;
  link: string | null;
  fields: Array<{ label: string; oldValue: string | null; newValue: string | null }>;
  recipients: string[];
}

/**
 * The one place every change email is handed to the queue — both the folded
 * per-request path above and `announceChange` below end here, which is why
 * `ALWAYS_NOTIFY_EMAILS` is merged in at this point rather than in either
 * caller. An address on that list therefore also receives the alert sweep's
 * messages, since those are announced through the same function.
 *
 * Merged *after* `filterByPreference` has run on the routed recipients, and
 * deliberately not subject to it: "copied on everything" is a deployment
 * decision, and a per-user preference row is not the place to overrule it.
 * `enqueueEmail` lowercases and de-duplicates, so someone who is both a routed
 * recipient and on this list is still mailed once.
 */
function queueEmail(changeEventId: string, input: EmailInput): void {
  const recipients = [...input.recipients, ...ALWAYS_NOTIFY_EMAILS];
  if (recipients.length === 0) return;

  const rendered = renderChangeEmail({
    summary: input.summary,
    orderLabel: input.orderLabel,
    actorName: input.actorName,
    when: input.when,
    priority: input.priority,
    fields: input.fields,
    link: input.link,
  });

  void enqueueEmail({
    changeEventId,
    recipients,
    subject: rendered.subject,
    bodyHtml: rendered.html,
    bodyText: rendered.text,
  }).catch((err: unknown) => {
    console.error('EMAIL QUEUE FAILED — the change and its notifications are unaffected:', err);
  });
}

/**
 * Announce one change that no diff could describe.
 *
 * The escape hatch for the handful of operations where the middleware's
 * per-row view is the wrong story. An Excel import writes several hundred rows;
 * the news is "PO 13506 was imported from a spreadsheet", once, not four
 * hundred inserts. Those call sites suppress the automatic events and call this
 * instead.
 *
 * Deliberately not exported to any route that handles ordinary edits. The point
 * of the middleware is that a handler cannot forget to record a change, and a
 * convenient manual API is how that guarantee gets quietly abandoned.
 */
export async function announceChange(input: {
  entityType: string;
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  category: ChangeCategory;
  summary: string;
  subject?: string | null;
  priority?: NotificationPriority;
  orderId?: string | null;
  link?: string | null;
  fields?: Array<{ label: string; oldValue: string | null; newValue: string | null }>;
  actorId: string | null;
  actorName: string;
  /** Overrides the category's default type — the alert sweep and task
   * assignment know more precisely what this is than the category alone. */
  notificationType?: NotificationType;
}): Promise<void> {
  try {
    const priority = input.priority ?? NotificationPriority.NORMAL;
    const order = input.orderId
      ? await prisma.order.findUnique({
          where: { id: input.orderId },
          select: { coordinatorId: true, outsideWorkManagerId: true },
        })
      : null;
    const raw = await resolveRecipients({
      category: input.category, priority,
      coordinatorId: order?.coordinatorId, outsideWorkManagerId: order?.outsideWorkManagerId,
      actorId: input.actorId,
    });

    const event = await prisma.changeEvent.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        category: input.category as never,
        subject: input.subject ?? null,
        summary: input.summary,
        priority: priority as never,
        orderId: input.orderId ?? null,
        actorId: input.actorId,
        actorName: input.actorName,
        link: input.link ?? null,
        fields: {
          create: (input.fields ?? []).map((f, i) => ({
            field: f.label, label: f.label,
            oldValue: f.oldValue, newValue: f.newValue, position: i,
          })),
        },
      },
      include: { fields: { orderBy: { position: 'asc' } } },
    });

    const notificationType = input.notificationType ?? mapCategoryToNotificationType(input.category);
    const inAppRecipients = await filterByPreference(raw, input.category, priority, 'inApp');
    if (inAppRecipients.length > 0) {
      await prisma.notification.createMany({
        data: inAppRecipients.map((r) => ({
          userId: r.id,
          orderId: input.orderId ?? null,
          changeEventId: event.id,
          type: notificationType as never,
          priority: priority as never,
          title: input.summary,
          body: (input.fields ?? []).map((f) => `${f.label}: ${f.newValue ?? '—'}`).join(' · ') || null,
          link: input.link ?? null,
        })),
      });
    }

    const emailRecipients = await filterByPreference(raw, input.category, priority, 'email');

    queueEmail(event.id, {
      summary: input.summary,
      subject: input.subject ?? null,
      priority,
      detail: null,
      actorName: input.actorName,
      when: event.createdAt,
      orderLabel: input.subject ?? null,
      link: input.link ?? null,
      fields: event.fields.map((f) => ({
        label: f.label, oldValue: f.oldValue, newValue: f.newValue,
      })),
      recipients: emailRecipients.map((r) => r.email),
    });
  } catch (err) {
    // Same rule as everywhere else here: announcing a change must never be able
    // to undo it. The import already succeeded by the time this runs.
    console.error('MANUAL CHANGE ANNOUNCEMENT FAILED:', err);
  }
}

export { foldChanges, buildLink } from './change-fold.js';
export type { FoldedChange } from './change-fold.js';
export type ChangeEventWithFields = Prisma.ChangeEventGetPayload<{
  include: { fields: true };
}>;
