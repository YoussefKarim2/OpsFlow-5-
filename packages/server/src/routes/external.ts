/**
 * External operations: work sent outside the factory and brought back.
 *
 * The factory does not hold outside work for customer approval, so nothing
 * here waits on one. Operations stored as WAITING_APPROVAL before that was
 * removed are not rewritten in the database; they are read, shown and moved on
 * exactly as NOT_SENT (`asNotSent`).
 */

import { Router } from 'express';
import { z } from 'zod';
import { daysBetween } from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { refreshOrderCache } from '../services/order-service.js';
import { logActivity } from '../services/activity-service.js';

export const externalRouter = Router();
externalRouter.use(authenticate);

const dec = (v: { toString(): string } | null | undefined): number | null =>
  v == null ? null : Number(v.toString());

const OP_STATUSES = ['NOT_SENT', 'SENT', 'IN_PROGRESS', 'RETURNED', 'CANCELLED'] as const;

/** A row from before approvals were removed reads as what it now is: not sent. */
export const asNotSent = (status: string): string => (status === 'WAITING_APPROVAL' ? 'NOT_SENT' : status);

// ── External operations ─────────────────────────────────────────────────────

externalRouter.get('/:orderId/operations', requirePermission('external:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const ops = await prisma.externalOperation.findMany({
    where: { orderId: order.id },
    include: { externalFactory: true, _count: { select: { attachments: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const today = new Date();
  res.json({
    data: ops.map((op) => ({
      id: op.id,
      externalFactoryName: op.externalFactory?.name ?? null,
      // Ids as well as names: the table editor writes back what it read, and a
      // name cannot be written back to a foreign key.
      externalFactoryId: op.externalFactoryId,
      externalReference: op.externalReference,
      operationType: op.operationType,
      operationTypeAr: op.operationTypeAr,
      operationSort: op.operationSort,
      qty: op.qty,
      unitRate: dec(op.unitRate),
      unitPriceUsd: dec(op.unitPriceUsd),
      totalPriceUsd: op.unitPriceUsd ? Number(op.unitPriceUsd.toString()) * op.qty : null,
      sentDate: op.sentDate?.toISOString() ?? null,
      expectedReturnDate: op.expectedReturnDate?.toISOString() ?? null,
      actualReturnDate: op.actualReturnDate?.toISOString() ?? null,
      status: asNotSent(op.status),
      notes: op.notes,
      colorIds: op.colorIds,
      attachmentCount: op._count.attachments,
      daysLate:
        !op.actualReturnDate && op.expectedReturnDate
          ? Math.max(0, -(daysBetween(today, op.expectedReturnDate) ?? 0))
          : null,
    })),
  });
}));

const opSchema = z.object({
  externalFactoryId: z.string().optional(),
  externalReference: z.string().optional(),
  operationType: z.string().min(1),
  operationTypeAr: z.string().optional(),
  operationSort: z.string().optional(),
  /**
   * Zero is allowed, and it matters.
   *
   * External work is declared on the order long before anyone knows how many
   * pieces it covers — "this order needs printing on the front and the back"
   * is a fact about the garment, settled at the point of sale; the quantity is
   * settled later, once the cut is planned. Insisting on a positive number
   * here meant the declaration could not be recorded at all until an unrelated
   * decision had been made, so it was recorded on a sticky note instead.
   */
  qty: z.number().int().nonnegative().default(0),
  unitRate: z.number().nonnegative().optional(),
  unitPriceUsd: z.number().nonnegative().optional(),
  expectedReturnDate: z.string().optional(),
  colorIds: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

externalRouter.post('/:orderId/operations', requirePermission('external:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = opSchema.parse(req.body);

  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) throw new NotFoundError('Order');

  const op = await prisma.externalOperation.create({
    data: {
      ...input,
      orderId: order.id,
      expectedReturnDate: input.expectedReturnDate ? new Date(input.expectedReturnDate) : null,
      status: 'NOT_SENT',
    },
  });

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'EXTERNAL_OP_CREATED',
    summary: `added external operation "${input.operationType}" for ${input.qty.toLocaleString()} pcs`,
    entityType: 'ExternalOperation', entityId: op.id,
  });

  await refreshOrderCache(order.id);
  res.status(201).json({ id: op.id, status: op.status });
}));

/**
 * Edit one operation's own details.
 *
 * Deliberately not the status: moving an operation along is the status route's
 * job, which stamps the sent and returned dates and logs the move.
 */
externalRouter.patch('/operations/:id', requirePermission('external:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = opSchema.partial().parse(req.body);

  const op = await prisma.externalOperation.findUnique({ where: { id: req.params.id } });
  if (!op) throw new NotFoundError('External operation');

  await prisma.externalOperation.update({
    where: { id: op.id },
    data: {
      ...input,
      ...(input.expectedReturnDate !== undefined
        ? { expectedReturnDate: input.expectedReturnDate ? new Date(input.expectedReturnDate) : null }
        : {}),
    },
  });

  await logActivity({
    orderId: op.orderId, actorId: actor.id, actorName: actor.name,
    action: 'EXTERNAL_OP_UPDATED',
    summary: `updated external operation "${op.operationType}"`,
    entityType: 'ExternalOperation', entityId: op.id,
  });

  await refreshOrderCache(op.orderId);
  res.json({ ok: true });
}));

externalRouter.delete('/operations/:id', requirePermission('external:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const op = await prisma.externalOperation.findUnique({ where: { id: req.params.id } });
  if (!op) throw new NotFoundError('External operation');

  // Work that has left the building is a fact, not a draft. Removing the record
  // would lose the only trace that it was sent, so it is refused and the status
  // route is the way to record what actually happened to it.
  if (op.status !== 'NOT_SENT' && op.status !== 'WAITING_APPROVAL') {
    throw new ValidationError(
      `This operation has already been ${op.status.toLowerCase().replace(/_/g, ' ')}. ` +
      'Record what happened to it instead of deleting it.',
    );
  }

  await prisma.externalOperation.delete({ where: { id: op.id } });
  await logActivity({
    orderId: op.orderId, actorId: actor.id, actorName: actor.name,
    action: 'EXTERNAL_OP_REMOVED',
    summary: `removed external operation "${op.operationType}"`,
    entityType: 'ExternalOperation', entityId: op.id,
  });

  await refreshOrderCache(op.orderId);
  res.status(204).end();
}));

/**
 * Save the whole external-work table at once — the Proforma Invoice's pattern.
 *
 * Diffs rather than replacing. A row that came back with its id keeps that id,
 * and with it the attachments filed against it and
 * the cost line derived from it — all of which are keyed on the operation and
 * would be orphaned by a delete-and-recreate.
 *
 * Rows that have left the building are never touched: a row already SENT is
 * updated in its editable fields only, and one omitted from the payload is kept
 * rather than deleted, for the same reason the DELETE above refuses it.
 */
/**
 * The bulk save's row schema — deliberately *not* `opSchema`.
 *
 * `opSchema` fills in defaults, which is right when creating one operation from
 * a form that shows every field, and wrong here. This endpoint now has two
 * callers: the External Order stage, which edits the whole row, and Order
 * Details, which edits only what kind of work the order needs. A default turns
 * "Details did not mention the expected return date" into "set the expected
 * return date to nothing", and the coordinator loses a date they entered on
 * another screen without touching it.
 *
 * So every field is optional with no default, and the update below writes only
 * the keys that actually arrived. Prisma ignores `undefined`, which is exactly
 * the semantics wanted: absent means unchanged, not cleared.
 */
const bulkRowSchema = z.object({
  id: z.string().optional(),
  externalFactoryId: z.string().optional(),
  externalReference: z.string().optional(),
  operationType: z.string().min(1),
  operationTypeAr: z.string().optional(),
  operationSort: z.string().optional(),
  qty: z.number().int().nonnegative().optional(),
  unitRate: z.number().nonnegative().optional(),
  unitPriceUsd: z.number().nonnegative().optional(),
  expectedReturnDate: z.string().nullable().optional(),
  colorIds: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

/**
 * The fields one bulk-saved row actually writes on update.
 *
 * Pulled out as a function so the rule can be tested without a database,
 * because the rule is the whole point: a key the caller did not send must not
 * appear in the result at all. Prisma treats `undefined` as "leave alone" and
 * `null` as "clear it", and the difference between those two is a coordinator's
 * expected return date.
 */
export function bulkUpdateData(row: z.infer<typeof bulkRowSchema>): Record<string, unknown> {
  const { id: _id, expectedReturnDate, ...fields } = row;
  return {
    ...fields,
    ...(expectedReturnDate !== undefined
      ? { expectedReturnDate: expectedReturnDate ? new Date(expectedReturnDate) : null }
      : {}),
  };
}

externalRouter.put('/:orderId/operations', requirePermission('external:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const rows = z.array(bulkRowSchema).parse(req.body.operations);

  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  let removable: string[] = [];

  await prisma.$transaction(async (tx) => {
    /**
     * One save of this order's table at a time.
     *
     * This endpoint reads the existing rows, works out which have gone, and
     * then writes — and two of those running at once both read "no Print Front
     * row yet" and both create one. Double-clicking Save was enough to do it:
     * the table came back with every row twice.
     *
     * A transaction alone does not help, because at READ COMMITTED neither
     * transaction can see the other's uncommitted insert. An advisory lock keyed
     * on the order does: the second save waits, then reads the first one's work
     * and updates the row instead of adding a second. It is scoped to the
     * transaction, so it is released however this ends, and it is keyed per
     * order, so two coordinators working on different orders never wait.
     */
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${order.id}))`;

    // Read inside the lock, or the diff is computed from a stale picture.
    const existing = await tx.externalOperation.findMany({
      where: { orderId: order.id },
      select: { id: true, status: true },
    });
    const keep = new Set(rows.map((r) => r.id).filter((id): id is string => !!id));
    removable = existing
      .filter((e) => !keep.has(e.id) && (e.status === 'NOT_SENT' || e.status === 'WAITING_APPROVAL'))
      .map((e) => e.id);

    if (removable.length > 0) {
      await tx.externalOperation.deleteMany({ where: { id: { in: removable } } });
    }
    for (const row of rows) {
      const { id, expectedReturnDate, ...fields } = row;
      if (id) {
        // Status is never written here; it belongs to the transition route.
        // Only the keys this caller sent are written — see bulkRowSchema.
        await tx.externalOperation.update({ where: { id }, data: bulkUpdateData(row) });
      } else {
        // A new row does need the defaults, since nothing exists to preserve.
        await tx.externalOperation.create({
          data: {
            ...fields,
            orderId: order.id,
            qty: row.qty ?? 0,
            expectedReturnDate: expectedReturnDate ? new Date(expectedReturnDate) : null,
            status: 'NOT_SENT',
          },
        });
      }
    }
  });

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'EXTERNAL_WORK_SAVED',
    summary: `saved external work — ${rows.length} operation${rows.length === 1 ? '' : 's'}` +
             (removable.length > 0 ? `, ${removable.length} removed` : ''),
    entityType: 'Order', entityId: order.id,
  });

  await refreshOrderCache(order.id);
  res.json({ ok: true, count: rows.length, removed: removable.length });
}));

const transitionSchema = z.object({
  status: z.enum(OP_STATUSES),
  sentDate: z.string().optional(),
  actualReturnDate: z.string().optional(),
  notes: z.string().optional(),
});

/** Move an operation along: sent, in progress, back, or cancelled. */
externalRouter.post('/operations/:id/status', requirePermission('external:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = transitionSchema.parse(req.body);

  const op = await prisma.externalOperation.findUnique({
    where: { id: req.params.id },
    include: { order: { select: { id: true, poNumber: true } } },
  });
  if (!op) throw new NotFoundError('External operation');

  await prisma.externalOperation.update({
    where: { id: op.id },
    data: {
      status: input.status,
      sentDate: input.sentDate ? new Date(input.sentDate) : input.status === 'SENT' ? new Date() : undefined,
      actualReturnDate:
        input.actualReturnDate ? new Date(input.actualReturnDate)
        : input.status === 'RETURNED' ? new Date()
        : undefined,
      notes: input.notes ?? op.notes,
    },
  });

  await logActivity({
    orderId: op.order.id, actorId: actor.id, actorName: actor.name,
    action: 'EXTERNAL_OP_STATUS',
    summary: `moved "${op.operationType}" to ${input.status.toLowerCase().replace(/_/g, ' ')}`,
    entityType: 'ExternalOperation', entityId: op.id,
    meta: { from: asNotSent(op.status), to: input.status },
  });

  await refreshOrderCache(op.order.id);
  res.json({ ok: true, status: input.status });
}));
