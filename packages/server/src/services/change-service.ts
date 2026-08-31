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
 *   3. Create an in-app notification for every active user except the actor.
 *   4. Queue one email to those same people, and hand it to the sender.
 *
 * Steps 2–4 each guard their own failure. A failed email leaves the event and
 * the notifications in place; a failed notification leaves the event in place;
 * a failed event leaves the audit trail in place, because that was written
 * during the request by different code.
 */

import {
  TRACKED_MODELS, NotificationPriority, ChangeCategory,
  formatValue, derivePriority, summariseChange, describeFieldChange,
} from '@opsflow/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import type { RequestContext } from '../request-context.js';
import { foldChanges, buildLink, type FoldedChange } from './change-fold.js';
import { renderChangeEmail } from './email/template.js';
import { enqueueEmail } from './email/email-queue.js';

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
  // Order PO numbers, so an event can say "PO 13506" rather than a cuid.
  const orderIds = [...new Set(folded.map((f) => f.orderId).filter((x): x is string => !!x))];
  const orders = orderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, poNumber: true, orderName: true },
      })
    : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const recipients = await activeRecipients(ctx.userId);

  for (const change of folded) {
    const order = change.orderId ? orderById.get(change.orderId) : undefined;
    const subject = order ? `PO ${order.poNumber}` : change.subjectHint;
    const tracked = TRACKED_MODELS[change.model];
    const priority = derivePriority(change.model, change.action, change.fields);
    const summary = summariseChange({
      model: change.model, action: change.action, subject, fields: change.fields,
    });
    const link = buildLink(change.model, change.orderId);

    let event;
    try {
      event = await prisma.changeEvent.create({
        data: {
          entityType: change.model,
          entityId: change.entityId,
          action: change.action,
          category: (tracked?.category ?? ChangeCategory.ORDER) as never,
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

    if (recipients.length > 0) {
      try {
        await prisma.notification.createMany({
          data: recipients.map((r) => ({
            userId: r.id,
            orderId: change.orderId,
            changeEventId: event.id,
            // The existing NotificationType enum has no generic member, and
            // adding one per model would be a taxonomy nobody reads. MENTIONED
            // is the closest existing "something concerns you" type; the
            // priority column is what the UI actually sorts and colours by.
            type: 'MENTIONED' as never,
            priority: priority as never,
            title: summary,
            body: detail,
            link,
          })),
        });
      } catch (err) {
        console.error('NOTIFICATION WRITE FAILED:', err);
      }

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
        recipients: recipients.map((r) => r.email),
      });
    }
  }
}

/**
 * Who hears about a change: every active user, from the users table.
 *
 * Two deliberate exclusions.
 *
 * The actor. Emailing somebody to tell them what they just did teaches people
 * that OpsFlow mail is noise, which is how the genuinely important message gets
 * missed. `NOTIFY_ACTOR=true` in the environment turns it back on for anyone
 * who disagrees; it is one setting, not a code change.
 *
 * Inactive accounts, which is the requirement, and is read from `active` — the
 * same column the sign-in check uses, so a disabled account stops receiving
 * mail at the same moment it stops being able to sign in.
 */
async function activeRecipients(
  actorId: string | null,
): Promise<Array<{ id: string; email: string; name: string }>> {
  const users = await prisma.user.findMany({
    where: {
      active: true,
      ...(config.NOTIFY_ACTOR || !actorId ? {} : { id: { not: actorId } }),
    },
    select: { id: true, email: true, name: true },
  });
  return users;
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

function queueEmail(changeEventId: string, input: EmailInput): void {
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
    recipients: input.recipients,
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
}): Promise<void> {
  try {
    const priority = input.priority ?? NotificationPriority.NORMAL;
    const recipients = await activeRecipients(input.actorId);

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

    if (recipients.length === 0) return;

    await prisma.notification.createMany({
      data: recipients.map((r) => ({
        userId: r.id,
        orderId: input.orderId ?? null,
        changeEventId: event.id,
        type: 'MENTIONED' as never,
        priority: priority as never,
        title: input.summary,
        body: (input.fields ?? []).map((f) => `${f.label}: ${f.newValue ?? '—'}`).join(' · ') || null,
        link: input.link ?? null,
      })),
    });

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
      recipients: recipients.map((r) => r.email),
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
