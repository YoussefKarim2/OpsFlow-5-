import { Router } from 'express';
import { z } from 'zod';
import {
  QtyLedger, computeProductionAnalytics, computeOperationTotals, computeLineTotals,
  ledgerTotals, type ProductionEntry,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError } from '../errors.js';
import { ORDER_INCLUDE, deriveOrder, refreshOrderCache } from '../services/order-service.js';
import { logAndNotify, logActivity } from '../services/activity-service.js';
import { assertValidQuantity, assertProductionWithinReason } from '../services/rules.js';

export const productionRouter = Router();
productionRouter.use(authenticate);

const OPERATIONS = ['CUTTING', 'SEWING', 'PRINTING', 'EMBROIDERY', 'WASHING', 'FINISHING', 'PACKING'] as const;

productionRouter.get('/:orderId', requirePermission('production:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    include: ORDER_INCLUDE,
  });
  if (!order) throw new NotFoundError('Order');

  const totals = ledgerTotals(deriveOrder(order).cells);
  const entries: ProductionEntry[] = order.productionRecords.map((p) => ({
    date: p.date, operation: p.operation, qty: p.qty, line: p.line, team: p.team,
  }));

  res.json({
    records: order.productionRecords.map((p) => ({
      id: p.id, date: p.date.toISOString(), operation: p.operation, qty: p.qty,
      line: p.line, team: p.team, notes: p.notes, recordedByName: null,
    })),
    analytics: computeProductionAnalytics({
      entries,
      orderQty: totals[QtyLedger.ORDER] ?? 0,
      cutQty: totals[QtyLedger.CUT] ?? 0,
      requiredDate: order.requiredDeliveryDate,
    }),
    byOperation: computeOperationTotals(entries),
    byLine: computeLineTotals(entries),
  });
}));

const recordSchema = z.object({
  date: z.string(),
  operation: z.enum(OPERATIONS),
  qty: z.number().int(),
  line: z.string().optional(),
  team: z.string().optional(),
  notes: z.string().optional(),
});

productionRouter.post('/:orderId', requirePermission('production:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = recordSchema.parse(req.body);
  assertValidQuantity(input.qty, 'Production quantity');

  const order = await prisma.order.findUnique({ where: { id: req.params.orderId }, include: ORDER_INCLUDE });
  if (!order) throw new NotFoundError('Order');

  const d = deriveOrder(order);
  const orderQty = d.totals[QtyLedger.ORDER] ?? 0;
  const cutQty = d.totals[QtyLedger.CUT] ?? 0;

  // Catch a fat-fingered 45000 at entry rather than at packing.
  if (input.operation === 'SEWING') {
    assertProductionWithinReason(d.production.producedQty + input.qty, orderQty, cutQty);
  }

  const record = await prisma.productionRecord.create({
    data: {
      orderId: order.id,
      date: new Date(input.date),
      operation: input.operation,
      qty: input.qty,
      line: input.line,
      team: input.team,
      notes: input.notes,
      recordedById: actor.id,
    },
  });

  // Recompute after the write so the delay notification reflects the new reality.
  const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_INCLUDE });
  const derivedAfter = deriveOrder(after);

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'PRODUCTION_RECORDED',
    summary: `recorded ${input.qty.toLocaleString()} pcs ${input.operation.toLowerCase()}${input.line ? ` on ${input.line}` : ''}`,
    entityType: 'ProductionRecord', entityId: record.id,
    meta: { operation: input.operation, qty: input.qty, line: input.line ?? null },
  });

  // Tell the coordinator the moment the order slips — not at the next review.
  if (derivedAfter.production.isBehindSchedule && !d.production.isBehindSchedule) {
    await logAndNotify(
      {
        orderId: order.id, actorId: actor.id, actorName: 'System',
        action: 'PRODUCTION_DELAY_DETECTED',
        summary: `production is now projected to finish ${derivedAfter.production.slipDays} day(s) after the required date`,
      },
      {
        type: 'PRODUCTION_DELAY',
        title: `${order.poNumber} is behind schedule`,
        body: `At the current rate the order finishes ${derivedAfter.production.slipDays} day(s) late. ` +
          `${Math.round(derivedAfter.production.requiredDailyRate ?? 0).toLocaleString()}/day is needed.`,
        link: `/orders/${order.id}?tab=production`,
        departments: ['FACTORY_MANAGER', 'PRODUCTION_MANAGER'],
      },
    );
  }

  await refreshOrderCache(order.id);
  res.status(201).json({
    record: {
      id: record.id, date: record.date.toISOString(), operation: record.operation,
      qty: record.qty, line: record.line, team: record.team, notes: record.notes,
    },
    analytics: derivedAfter.production,
  });
}));

productionRouter.delete('/record/:id', requirePermission('production:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const record = await prisma.productionRecord.findUnique({ where: { id: req.params.id } });
  if (!record) throw new NotFoundError('Production record');

  await prisma.productionRecord.delete({ where: { id: record.id } });
  await logActivity({
    orderId: record.orderId, actorId: actor.id, actorName: actor.name,
    action: 'PRODUCTION_DELETED',
    summary: `removed a production entry of ${record.qty.toLocaleString()} pcs ${record.operation.toLowerCase()}`,
    entityType: 'ProductionRecord', entityId: record.id,
  });

  await refreshOrderCache(record.orderId);
  res.status(204).end();
}));
