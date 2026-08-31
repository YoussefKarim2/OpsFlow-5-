import { Router } from 'express';
import { z } from 'zod';
import {
  computeAudit, correctiveActionBody, AQL_TABLE, lookupAql, DEFECT_CATEGORIES,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError } from '../errors.js';
import { refreshOrderCache } from '../services/order-service.js';
import { logActivity } from '../services/activity-service.js';
import { createCorrectiveActionTask } from '../services/workflow-service.js';

export const qualityRouter = Router();
qualityRouter.use(authenticate);

/** The AQL sampling table, so the UI can show the auditor which band applies. */
qualityRouter.get('/aql', asyncHandler(async (req, res) => {
  const qty = Number(req.query.qty);
  res.json({
    table: AQL_TABLE.map((b) => ({ ...b, maxQty: Number.isFinite(b.maxQty) ? b.maxQty : null })),
    match: Number.isFinite(qty) ? lookupAql(qty) : null,
    defectCategories: DEFECT_CATEGORIES,
  });
}));

qualityRouter.get('/:orderId', requirePermission('quality:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const audits = await prisma.qualityAudit.findMany({
    where: { orderId: order.id },
    include: { defects: true, auditor: true, factory: true },
    orderBy: { inspectionDate: 'desc' },
  });

  res.json({
    data: audits.map((a) => {
      const computed = computeAudit({
        availableQty: a.availableQty,
        sampleSize: a.sampleSize,
        defects: a.defects.map((d) => ({ category: d.category, qty: d.qty, comment: d.comment })),
        manualResult: a.overridden ? (a.result as 'PASS' | 'FAIL') : null,
      });
      return {
        id: a.id,
        inspectionDate: a.inspectionDate.toISOString(),
        factoryName: a.factory?.name ?? null,
        auditType: a.auditType,
        availableQty: a.availableQty,
        sampleSize: a.sampleSize ?? computed.sampleSize,
        acceptedQty: a.acceptedQty ?? computed.acceptedQty,
        rejectedQty: a.rejectedQty ?? computed.rejectedQty,
        result: a.result,
        overridden: a.overridden,
        computedResult: computed.computedResult,
        aqlBand: computed.band,
        defectRatePct: computed.defectRatePct,
        remarks: a.remarks,
        correctiveAction: a.correctiveAction,
        correctiveActionClosed: a.correctiveActionClosed,
        reinspectFor: a.reinspectFor,
        auditorName: a.auditor?.name ?? null,
        factoryRepName: a.factoryRepName,
        colorsInspected: a.colorsInspected,
        sizesInspected: a.sizesInspected,
        defects: a.defects.map((d) => ({
          id: d.id, category: d.category, qty: d.qty, comment: d.comment, isReinspection: d.isReinspection,
        })),
      };
    }),
  });
}));

const auditSchema = z.object({
  inspectionDate: z.string().optional(),
  factoryId: z.string().optional(),
  auditType: z.enum(['FINAL_AUDIT', 'BEFORE_IRON', 'BEFORE_PACKING', 'IN_PACKING', 'INLINE']).default('FINAL_AUDIT'),
  availableQty: z.number().int().positive(),
  sampleSize: z.number().int().positive().optional(),
  defects: z.array(z.object({
    category: z.enum(DEFECT_CATEGORIES),
    qty: z.number().int().nonnegative(),
    comment: z.string().optional(),
  })).default([]),
  /** Only set when the auditor is deliberately overriding the AQL verdict. */
  manualResult: z.enum(['PASS', 'FAIL']).optional(),
  remarks: z.string().optional(),
  correctiveAction: z.string().optional(),
  reinspectFor: z.string().optional(),
  factoryRepName: z.string().optional(),
  colorsInspected: z.array(z.string()).default([]),
  sizesInspected: z.array(z.string()).default([]),
});

/**
 * Record an audit. The AQL table decides PASS/FAIL; a manual override is
 * allowed but flagged. A FAIL automatically creates the corrective-action task
 * and blocks the order — the brief's section 22, and the reason a failed audit
 * can no longer be quietly forgotten.
 */
qualityRouter.post('/:orderId', requirePermission('quality:audit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = auditSchema.parse(req.body);

  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) throw new NotFoundError('Order');

  const computed = computeAudit({
    availableQty: input.availableQty,
    sampleSize: input.sampleSize,
    defects: input.defects,
    manualResult: input.manualResult ?? null,
  });

  const audit = await prisma.$transaction(async (tx) => {
    const created = await tx.qualityAudit.create({
      data: {
        orderId: order.id,
        inspectionDate: input.inspectionDate ? new Date(input.inspectionDate) : new Date(),
        factoryId: input.factoryId,
        auditType: input.auditType,
        availableQty: input.availableQty,
        sampleSize: computed.sampleSize,
        acceptedQty: computed.acceptedQty,
        rejectedQty: computed.rejectedQty,
        result: computed.result,
        overridden: computed.overridden,
        remarks: input.remarks,
        correctiveAction: input.correctiveAction ?? (computed.result === 'FAIL' ? correctiveActionBody(computed, input.defects) : null),
        correctiveActionClosed: computed.result !== 'FAIL',
        reinspectFor: input.reinspectFor,
        auditorId: actor.id,
        factoryRepName: input.factoryRepName,
        colorsInspected: input.colorsInspected,
        sizesInspected: input.sizesInspected,
        defects: {
          create: input.defects
            .filter((d) => d.qty > 0)
            .map((d) => ({ category: d.category, qty: d.qty, comment: d.comment })),
        },
      },
    });

    if (computed.result === 'FAIL') {
      await createCorrectiveActionTask(tx, {
        orderId: order.id,
        auditId: created.id,
        body: correctiveActionBody(computed, input.defects),
        actorId: actor.id,
        actorName: actor.name,
      });
    }

    return created;
  });

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: computed.result === 'FAIL' ? 'QUALITY_AUDIT_FAILED' : 'QUALITY_AUDIT_PASSED',
    summary:
      `recorded a ${input.auditType.replace(/_/g, ' ').toLowerCase()}: ${computed.result} — ` +
      `${computed.totalDefects} defect${computed.totalDefects === 1 ? '' : 's'} in a sample of ${computed.sampleSize ?? '—'}` +
      (computed.overridden ? ' (manually overridden)' : ''),
    entityType: 'QualityAudit', entityId: audit.id,
    meta: { result: computed.result, defects: computed.totalDefects, sampleSize: computed.sampleSize },
  });

  await refreshOrderCache(order.id);
  res.status(201).json({ id: audit.id, result: computed.result, computed });
}));

/** Close a corrective action, which unblocks the order. */
qualityRouter.post('/audit/:id/close-corrective-action', requirePermission('quality:audit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const note = z.object({ note: z.string().optional() }).parse(req.body ?? {}).note;

  const audit = await prisma.qualityAudit.findUnique({ where: { id: req.params.id } });
  if (!audit) throw new NotFoundError('Quality audit');

  await prisma.$transaction(async (tx) => {
    await tx.qualityAudit.update({
      where: { id: audit.id },
      data: {
        correctiveActionClosed: true,
        remarks: note ? `${audit.remarks ?? ''}\n\nCorrective action closed: ${note}`.trim() : audit.remarks,
      },
    });
    await tx.task.updateMany({
      where: { sourceAuditId: audit.id, status: { not: 'COMPLETED' } },
      data: { status: 'COMPLETED', completedAt: new Date(), completedById: actor.id },
    });
  });

  await logActivity({
    orderId: audit.orderId, actorId: actor.id, actorName: actor.name,
    action: 'CORRECTIVE_ACTION_CLOSED',
    summary: 'closed the corrective action — the order is no longer quality-blocked',
    entityType: 'QualityAudit', entityId: audit.id,
  });

  await refreshOrderCache(audit.orderId);
  res.json({ ok: true });
}));
