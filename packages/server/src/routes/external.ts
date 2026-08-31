/**
 * External operations and customer approvals.
 *
 * This router is where the workbook's most important unenforced rule becomes
 * enforced. `External Order!M15` says, in Arabic:
 *
 *   "برجاء عدم البدء ف طباعه الاوردر الا بعد موافقه العميل"
 *   — do not begin printing the order until the customer approves.
 *
 * In a spreadsheet that is a note. Here, `assertExternalOpMayStart` refuses the
 * transition.
 */

import { Router } from 'express';
import { z } from 'zod';
import { daysBetween } from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError } from '../errors.js';
import { assertExternalOpMayStart } from '../services/rules.js';
import { refreshOrderCache } from '../services/order-service.js';
import { logActivity, logAndNotify } from '../services/activity-service.js';

export const externalRouter = Router();
externalRouter.use(authenticate);

const dec = (v: { toString(): string } | null | undefined): number | null =>
  v == null ? null : Number(v.toString());

const OP_STATUSES = ['NOT_SENT', 'WAITING_APPROVAL', 'SENT', 'IN_PROGRESS', 'RETURNED', 'CANCELLED'] as const;
const APPROVAL_TYPES = ['PRINT_ARTWORK', 'EMBROIDERY', 'COLOR', 'SAMPLE', 'LABEL', 'PACKING', 'PRODUCTION'] as const;

// ── External operations ─────────────────────────────────────────────────────

externalRouter.get('/:orderId/operations', requirePermission('external:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const ops = await prisma.externalOperation.findMany({
    where: { orderId: order.id },
    include: { externalFactory: true, approval: true, _count: { select: { attachments: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const today = new Date();
  res.json({
    data: ops.map((op) => ({
      id: op.id,
      externalFactoryName: op.externalFactory?.name ?? null,
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
      status: op.status,
      requiresApproval: op.requiresApproval,
      approvalCleared: op.approval?.status === 'APPROVED',
      approvalStatus: op.approval?.status ?? null,
      approvalId: op.approvalId,
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
  qty: z.number().int().positive(),
  unitRate: z.number().nonnegative().optional(),
  unitPriceUsd: z.number().nonnegative().optional(),
  expectedReturnDate: z.string().optional(),
  requiresApproval: z.boolean().default(false),
  approvalId: z.string().optional(),
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
      // An operation that needs approval starts in WAITING_APPROVAL, so its
      // real state is visible from the moment it is created.
      status: input.requiresApproval ? 'WAITING_APPROVAL' : 'NOT_SENT',
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

const transitionSchema = z.object({
  status: z.enum(OP_STATUSES),
  sentDate: z.string().optional(),
  actualReturnDate: z.string().optional(),
  notes: z.string().optional(),
});

/**
 * The gate. Moving an operation to SENT / IN_PROGRESS / RETURNED requires the
 * customer approval when the operation demands one.
 */
externalRouter.post('/operations/:id/status', requirePermission('external:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = transitionSchema.parse(req.body);

  const op = await prisma.externalOperation.findUnique({
    where: { id: req.params.id },
    include: { approval: true, order: { select: { id: true, poNumber: true } } },
  });
  if (!op) throw new NotFoundError('External operation');

  // Throws ApprovalRequiredError (409) with a message the UI shows verbatim.
  assertExternalOpMayStart({
    operationType: op.operationType,
    requiresApproval: op.requiresApproval,
    approvalStatus: op.approval?.status,
    targetStatus: input.status,
  });

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
    meta: { from: op.status, to: input.status },
  });

  await refreshOrderCache(op.order.id);
  res.json({ ok: true, status: input.status });
}));

// ── Approvals ───────────────────────────────────────────────────────────────

externalRouter.get('/:orderId/approvals', requirePermission('approval:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const approvals = await prisma.approval.findMany({
    where: { orderId: order.id },
    include: { requestedBy: true, _count: { select: { attachments: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const today = new Date();
  res.json({
    data: approvals.map((a) => ({
      id: a.id,
      type: a.type,
      typeLabel: a.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      status: a.status,
      blocking: a.blocking,
      requestedDate: a.requestedDate?.toISOString() ?? null,
      requestedByName: a.requestedBy?.name ?? null,
      sentTo: a.sentTo,
      approvedDate: a.approvedDate?.toISOString() ?? null,
      approvedByName: a.approvedByName,
      comment: a.comment,
      attachmentCount: a._count.attachments,
      daysOutstanding:
        a.status === 'PENDING' && a.requestedDate
          ? Math.max(0, -(daysBetween(today, a.requestedDate) ?? 0))
          : null,
    })),
  });
}));

const requestSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  sentTo: z.string().optional(),
  blocking: z.boolean().default(true),
  comment: z.string().optional(),
  /** Link this approval to an external operation, creating the gate. */
  externalOperationId: z.string().optional(),
});

externalRouter.post('/:orderId/approvals', requirePermission('approval:request'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = requestSchema.parse(req.body);

  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) throw new NotFoundError('Order');

  const approval = await prisma.$transaction(async (tx) => {
    const created = await tx.approval.create({
      data: {
        orderId: order.id,
        type: input.type,
        sentTo: input.sentTo,
        blocking: input.blocking,
        comment: input.comment,
        requestedDate: new Date(),
        requestedById: actor.id,
        status: 'PENDING',
      },
    });
    if (input.externalOperationId) {
      await tx.externalOperation.update({
        where: { id: input.externalOperationId },
        data: { approvalId: created.id, requiresApproval: true, status: 'WAITING_APPROVAL' },
      });
    }
    return created;
  });

  await logAndNotify(
    {
      orderId: order.id, actorId: actor.id, actorName: actor.name,
      action: 'APPROVAL_REQUESTED',
      summary: `requested ${input.type.replace(/_/g, ' ').toLowerCase()} approval${input.sentTo ? ` from ${input.sentTo}` : ''}`,
      entityType: 'Approval', entityId: approval.id,
    },
    {
      type: 'APPROVAL_REQUESTED',
      title: `Approval requested on ${order.poNumber}`,
      body: `${input.type.replace(/_/g, ' ')} — awaiting the customer.`,
      link: `/orders/${order.id}?tab=approvals`,
      departments: ['EXTERNAL_OPS'],
    },
  );

  await refreshOrderCache(order.id);
  res.status(201).json({ id: approval.id });
}));

const recordSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  approvedByName: z.string().optional(),
  comment: z.string().optional(),
});

externalRouter.post('/approvals/:id/record', requirePermission('approval:record'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = recordSchema.parse(req.body);

  const approval = await prisma.approval.findUnique({
    where: { id: req.params.id },
    include: { order: { select: { id: true, poNumber: true } }, externalOperation: true },
  });
  if (!approval) throw new NotFoundError('Approval');

  await prisma.$transaction(async (tx) => {
    await tx.approval.update({
      where: { id: approval.id },
      data: {
        status: input.status,
        approvedDate: new Date(),
        approvedByName: input.approvedByName ?? actor.name,
        comment: input.comment ?? approval.comment,
      },
    });

    // Approval clears the gate: the blocked operation becomes releasable.
    if (input.status === 'APPROVED' && approval.externalOperation) {
      await tx.externalOperation.update({
        where: { id: approval.externalOperation.id },
        data: { status: 'NOT_SENT' },
      });
    }
  });

  await logAndNotify(
    {
      orderId: approval.order.id, actorId: actor.id, actorName: actor.name,
      action: 'APPROVAL_RECORDED',
      summary: `recorded ${approval.type.replace(/_/g, ' ').toLowerCase()} approval as ${input.status.replace(/_/g, ' ').toLowerCase()}`,
      entityType: 'Approval', entityId: approval.id,
      meta: { status: input.status },
    },
    {
      type: 'APPROVAL_RECEIVED',
      title:
        input.status === 'APPROVED'
          ? `Approval received on ${approval.order.poNumber}`
          : `Approval ${input.status.replace(/_/g, ' ').toLowerCase()} on ${approval.order.poNumber}`,
      body: approval.externalOperation
        ? input.status === 'APPROVED'
          ? `"${approval.externalOperation.operationType}" can now be released to the external factory.`
          : `"${approval.externalOperation.operationType}" remains blocked.`
        : null,
      link: `/orders/${approval.order.id}?tab=approvals`,
      departments: ['EXTERNAL_OPS', 'COORDINATOR'],
    },
  );

  await refreshOrderCache(approval.order.id);
  res.json({ ok: true, status: input.status });
}));

/** Every pending approval across every order — the dashboard card's source. */
externalRouter.get('/approvals/pending', requirePermission('approval:read'), asyncHandler(async (_req, res) => {
  const approvals = await prisma.approval.findMany({
    where: { status: 'PENDING', order: { cancelled: false } },
    include: { order: { select: { id: true, poNumber: true, orderName: true } }, requestedBy: true },
    orderBy: { requestedDate: 'asc' },
  });

  const today = new Date();
  res.json({
    data: approvals.map((a) => ({
      id: a.id,
      orderId: a.order.id,
      orderPoNumber: a.order.poNumber,
      orderName: a.order.orderName,
      type: a.type,
      blocking: a.blocking,
      sentTo: a.sentTo,
      requestedDate: a.requestedDate?.toISOString() ?? null,
      requestedByName: a.requestedBy?.name ?? null,
      daysOutstanding: a.requestedDate ? Math.max(0, -(daysBetween(today, a.requestedDate) ?? 0)) : null,
    })),
  });
}));
