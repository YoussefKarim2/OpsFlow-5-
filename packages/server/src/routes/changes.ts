/**
 * "What changed?" — the change feed, factory-wide and per order.
 *
 * Read-only. Nothing here writes anything, which is the point: change events
 * are produced by the audit middleware and the change service, never by a
 * request asking to create one. A client cannot post a change into this feed
 * and cannot choose who it says made it.
 */

import { Router } from 'express';
import { z } from 'zod';
import { CATEGORY_LABEL, PRIORITY_STYLE } from '@opsflow/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { requirePermission, requireSuperAdmin, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { drainQueue, enqueueEmail } from '../services/email/email-queue.js';
import { missingGraphConfig } from '../services/email/graph-mailer.js';
import { renderTestEmail } from '../services/email/template.js';

export const changesRouter = Router();

const CATEGORIES = [
  'ORDER', 'PRODUCTION', 'INVENTORY', 'MATERIALS', 'TASKS',
  'QUALITY', 'SHIPMENT', 'APPROVALS', 'DOCUMENTS', 'ADMIN',
] as const;

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

/**
 * A date that is either absent or real.
 *
 * An unvalidated string reaching Prisma as `Invalid Date` is a 500, and this
 * exact bug was found and fixed on the admin audit route in Phase 1. The same
 * guard belongs on every filter that takes a date.
 */
const dateFilter = z
  .string()
  .optional()
  .refine((v) => v === undefined || v === '' || !Number.isNaN(Date.parse(v)), {
    message: 'Not a date OpsFlow can read. Use YYYY-MM-DD.',
  })
  .transform((v) => (v && v !== '' ? new Date(v) : undefined));

const feedQuery = z.object({
  category: z.enum(CATEGORIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  actorId: z.string().optional(),
  orderId: z.string().optional(),
  entityType: z.string().optional(),
  /** Free text over the summary, so "delivery" finds delivery-date changes. */
  q: z.string().trim().max(120).optional(),
  from: dateFilter,
  to: dateFilter,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function endOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(23, 59, 59, 999);
  return copy;
}

const eventInclude = {
  fields: { orderBy: { position: 'asc' } },
  order: { select: { id: true, poNumber: true, orderName: true } },
} satisfies Prisma.ChangeEventInclude;

type EventRow = Prisma.ChangeEventGetPayload<{ include: typeof eventInclude }>;

function toDto(e: EventRow) {
  return {
    id: e.id,
    entityType: e.entityType,
    entityId: e.entityId,
    action: e.action,
    category: e.category,
    categoryLabel: CATEGORY_LABEL[e.category as keyof typeof CATEGORY_LABEL] ?? e.category,
    subject: e.subject,
    summary: e.summary,
    priority: e.priority,
    priorityLabel: PRIORITY_STYLE[e.priority as keyof typeof PRIORITY_STYLE]?.label ?? e.priority,
    orderId: e.orderId,
    orderPoNumber: e.order?.poNumber ?? null,
    orderName: e.order?.orderName ?? null,
    actorId: e.actorId,
    actorName: e.actorName,
    link: e.link,
    reason: e.reason,
    createdAt: e.createdAt.toISOString(),
    fields: e.fields.map((f) => ({
      field: f.field,
      label: f.label,
      oldValue: f.oldValue,
      newValue: f.newValue,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The factory-wide feed
// ─────────────────────────────────────────────────────────────────────────────

changesRouter.get('/', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const q = feedQuery.parse(req.query);

  const where: Prisma.ChangeEventWhereInput = {
    ...(q.category ? { category: q.category as never } : {}),
    ...(q.priority ? { priority: q.priority as never } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.orderId ? { orderId: q.orderId } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.q ? { summary: { contains: q.q, mode: 'insensitive' as const } } : {}),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: q.from } : {}),
            ...(q.to ? { lte: endOfDay(q.to) } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.changeEvent.findMany({
      where,
      include: eventInclude,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.changeEvent.count({ where }),
  ]);

  res.json({
    data: rows.map(toDto),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  });
}));

/**
 * The filter options, built from what is actually in the feed.
 *
 * A dropdown listing every user in the factory, most of whom have never
 * changed anything, is a dropdown nobody can use. This lists the people who
 * appear in the feed, and how often.
 */
changesRouter.get('/filters', requirePermission('order:read'), asyncHandler(async (_req, res) => {
  const [actors, categories, priorities] = await Promise.all([
    prisma.changeEvent.groupBy({
      by: ['actorId', 'actorName'],
      _count: { _all: true },
      orderBy: { _count: { actorId: 'desc' } },
      take: 50,
    }),
    prisma.changeEvent.groupBy({ by: ['category'], _count: { _all: true } }),
    prisma.changeEvent.groupBy({ by: ['priority'], _count: { _all: true } }),
  ]);

  res.json({
    actors: actors
      .filter((a) => a.actorId)
      .map((a) => ({ id: a.actorId!, name: a.actorName, count: a._count._all })),
    categories: categories.map((c) => ({
      key: c.category,
      label: CATEGORY_LABEL[c.category as keyof typeof CATEGORY_LABEL] ?? c.category,
      count: c._count._all,
    })),
    priorities: priorities.map((p) => ({ key: p.priority, count: p._count._all })),
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// One order's history
// ─────────────────────────────────────────────────────────────────────────────

changesRouter.get('/order/:id', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.id }, { poNumber: req.params.id }] },
    select: { id: true, poNumber: true },
  });
  if (!order) throw new NotFoundError('Order');

  const take = Math.min(Number(req.query.limit ?? 200) || 200, 500);
  const rows = await prisma.changeEvent.findMany({
    where: { orderId: order.id },
    include: eventInclude,
    orderBy: { createdAt: 'desc' },
    take,
  });

  res.json({ data: rows.map(toDto), orderId: order.id, poNumber: order.poNumber });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Email delivery status
//
// Behind `audit:read` rather than being public: it names every recipient of
// every message, which is a directory of the factory.
// ─────────────────────────────────────────────────────────────────────────────

changesRouter.get('/emails', requirePermission('audit:read'), asyncHandler(async (req, res) => {
  const status = z.enum(['PENDING', 'SENT', 'FAILED']).optional().parse(req.query.status);
  const rows = await prisma.emailDelivery.findMany({
    where: status ? { status: status as never } : {},
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, subject: true, recipients: true, status: true, attempts: true,
      lastError: true, sentAt: true, nextAttemptAt: true, createdAt: true,
      changeEventId: true,
    },
  });

  const counts = await prisma.emailDelivery.groupBy({
    by: ['status'],
    _count: { _all: true },
  });

  res.json({
    data: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      recipientCount: r.recipients.length,
      recipients: r.recipients,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      sentAt: r.sentAt?.toISOString() ?? null,
      nextAttemptAt: r.nextAttemptAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      changeEventId: r.changeEventId,
    })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    // What is missing, never what is configured — the secret is never named.
    configured: missingGraphConfig().length === 0,
    missingSettings: missingGraphConfig(),
  });
}));

/**
 * Force a queue pass now, rather than waiting for the timer.
 *
 * Super-admin only. It is not dangerous, but it is an outbound-mail trigger,
 * and those belong with the people who own the mailbox.
 */
changesRouter.post('/emails/retry', requireSuperAdmin, asyncHandler(async (_req, res) => {
  const result = await drainQueue(100);
  res.json({ ...result, missingSettings: missingGraphConfig() });
}));

/**
 * Send one real test email, to the person asking for it and nobody else.
 *
 * This is how you verify the Microsoft Graph setup without waiting for
 * somebody to change an order, and without mailing the whole factory to find
 * out whether a client secret is right. It goes only to the caller's own
 * address, which is read from their authenticated session — not from the
 * request body, so this cannot be used to mail an arbitrary stranger.
 */
changesRouter.post('/emails/test', requireSuperAdmin, asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const missing = missingGraphConfig();
  if (missing.length > 0) {
    throw new ValidationError(
      `Microsoft 365 email is not configured yet. Missing: ${missing.join(', ')}. ` +
      `Add them to .env and restart the API.`,
    );
  }

  const rendered = renderTestEmail(actor.name);
  const id = await enqueueEmail({
    recipients: [actor.email],
    subject: rendered.subject,
    bodyHtml: rendered.html,
    bodyText: rendered.text,
  });

  // Give the immediate attempt a moment, then report what actually happened —
  // "queued" is a much less useful answer than "sent" or the reason it wasn't.
  await new Promise((r) => setTimeout(r, 1500));
  const row = id
    ? await prisma.emailDelivery.findUnique({
        where: { id },
        select: { status: true, lastError: true, attempts: true },
      })
    : null;

  res.json({
    sentTo: actor.email,
    status: row?.status ?? 'PENDING',
    attempts: row?.attempts ?? 0,
    error: row?.lastError ?? null,
    note:
      row?.status === 'SENT'
        ? 'Microsoft Graph accepted the message. Check the inbox — and the junk folder on a first send.'
        : 'The message is queued. It will be retried automatically; the error above says why it has not gone yet.',
  });
}));
