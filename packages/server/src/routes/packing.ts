import { Router } from 'express';
import { z } from 'zod';
import { QtyLedger, ledgerTotals } from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { ORDER_INCLUDE, deriveOrder, refreshOrderCache } from '../services/order-service.js';
import { logActivity, logAndNotify } from '../services/activity-service.js';
import { assertShippableQuantity } from '../services/rules.js';
import { getRequestContext } from '../request-context.js';

export const packingRouter = Router();
packingRouter.use(authenticate);

const dec = (v: { toString(): string } | null | undefined): number | null =>
  v == null ? null : Number(v.toString());

// ── Packing ─────────────────────────────────────────────────────────────────

packingRouter.get('/:orderId', requirePermission('packing:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const lists = await prisma.packingList.findMany({
    where: { orderId: order.id },
    include: {
      cartons: {
        include: {
          orderColor: { include: { color: true } },
          orderSize: { include: { size: true } },
        },
        orderBy: { position: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    data: lists.map((l) => {
      const cartons = l.cartons.map((c) => ({
        id: c.id,
        cartonNumber: c.cartonNumber,
        cartonSize: c.cartonSize,
        colorName: c.orderColor?.color.name ?? null,
        sizeName: c.orderSize?.size.name ?? null,
        qty: c.qty,
        grossWeightKg: dec(c.grossWeightKg),
        netWeightKg: dec(c.netWeightKg),
      }));
      return {
        id: l.id,
        reference: l.reference,
        approved: l.approved,
        approvedAt: l.approvedAt?.toISOString() ?? null,
        approvedByName: l.approvedByName,
        notes: l.notes,
        cartons,
        // Totals are derived here, not stored, exactly as everywhere else.
        totals: {
          cartonCount: cartons.length,
          totalQty: cartons.reduce((a, c) => a + c.qty, 0),
          grossWeightKg: cartons.reduce((a, c) => a + (c.grossWeightKg ?? 0), 0),
          netWeightKg: cartons.reduce((a, c) => a + (c.netWeightKg ?? 0), 0),
        },
      };
    }),
  });
}));

packingRouter.post('/:orderId', requirePermission('packing:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = z.object({ reference: z.string().optional(), notes: z.string().optional() }).parse(req.body ?? {});

  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) throw new NotFoundError('Order');

  const list = await prisma.packingList.create({ data: { ...input, orderId: order.id } });
  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'PACKING_LIST_CREATED', summary: 'created a packing list',
    entityType: 'PackingList', entityId: list.id,
  });

  res.status(201).json({ id: list.id });
}));

const cartonSchema = z.object({
  cartonNumber: z.string().min(1),
  cartonSize: z.string().optional(),
  orderColorId: z.string().optional(),
  orderSizeId: z.string().optional(),
  qty: z.number().int().positive(),
  grossWeightKg: z.number().nonnegative().optional(),
  netWeightKg: z.number().nonnegative().optional(),
});

packingRouter.post('/list/:listId/cartons', requirePermission('packing:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = cartonSchema.parse(req.body);

  const list = await prisma.packingList.findUnique({ where: { id: req.params.listId } });
  if (!list) throw new NotFoundError('Packing list');
  if (list.approved) {
    throw new ValidationError('This packing list has been approved. Reopen it before adding cartons.');
  }
  if (input.netWeightKg != null && input.grossWeightKg != null && input.netWeightKg > input.grossWeightKg) {
    throw new ValidationError('Net weight cannot exceed gross weight.');
  }

  const count = await prisma.carton.count({ where: { packingListId: list.id } });
  const carton = await prisma.carton.create({ data: { ...input, packingListId: list.id, position: count } });

  // Keep the PACKED ledger in step with the cartons, so the funnel, the
  // dashboard and the packing tab always agree.
  if (input.orderColorId && input.orderSizeId) {
    await prisma.stageQuantity.upsert({
      where: {
        orderId_orderColorId_orderSizeId_ledger: {
          orderId: list.orderId, orderColorId: input.orderColorId, orderSizeId: input.orderSizeId, ledger: 'PACKED',
        },
      },
      create: {
        orderId: list.orderId, orderColorId: input.orderColorId, orderSizeId: input.orderSizeId,
        ledger: 'PACKED', qty: input.qty,
      },
      update: { qty: { increment: input.qty } },
    });
  }

  await logActivity({
    orderId: list.orderId, actorId: actor.id, actorName: actor.name,
    action: 'CARTON_ADDED',
    summary: `packed carton ${input.cartonNumber} — ${input.qty} pcs`,
    entityType: 'Carton', entityId: carton.id,
  });

  await refreshOrderCache(list.orderId);
  res.status(201).json({ id: carton.id });
}));

packingRouter.post('/list/:listId/approve', requirePermission('packing:approve'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);

  const list = await prisma.packingList.findUnique({
    where: { id: req.params.listId },
    include: { cartons: true, order: { select: { id: true, poNumber: true } } },
  });
  if (!list) throw new NotFoundError('Packing list');
  if (list.cartons.length === 0) {
    throw new ValidationError('There are no cartons to approve. Add the cartons first.');
  }

  await prisma.packingList.update({
    where: { id: list.id },
    data: { approved: true, approvedAt: new Date(), approvedByName: actor.name },
  });

  const totalQty = list.cartons.reduce((a, c) => a + c.qty, 0);
  await logAndNotify(
    {
      orderId: list.orderId, actorId: actor.id, actorName: actor.name,
      action: 'PACKING_APPROVED',
      summary: `approved the packing list — ${list.cartons.length} cartons, ${totalQty.toLocaleString()} pcs`,
      entityType: 'PackingList', entityId: list.id,
    },
    {
      type: 'PACKING_COMPLETED',
      title: `Packing approved on ${list.order.poNumber}`,
      body: `${list.cartons.length} cartons, ${totalQty.toLocaleString()} pieces. Ready to book the shipment.`,
      link: `/orders/${list.orderId}?tab=shipping`,
      departments: ['PACKING', 'COORDINATOR'],
    },
  );

  await refreshOrderCache(list.orderId);
  res.json({ ok: true });
}));

// ── Shipping ────────────────────────────────────────────────────────────────

packingRouter.get('/:orderId/shipments', requirePermission('shipment:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const shipments = await prisma.shipment.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    data: shipments.map((s) => ({
      id: s.id, method: s.method, status: s.status, qty: s.qty,
      promisedShippingDate: s.promisedShippingDate?.toISOString() ?? null,
      requiredDeliveryDate: s.requiredDeliveryDate?.toISOString() ?? null,
      actualShippingDate: s.actualShippingDate?.toISOString() ?? null,
      deliveredDate: s.deliveredDate?.toISOString() ?? null,
      trackingNumber: s.trackingNumber, carrier: s.carrier, awbNumber: s.awbNumber,
      finalDestination: s.finalDestination, notes: s.notes,
      overrideApproved: s.overrideApproved, overrideReason: s.overrideReason,
    })),
  });
}));

const shipmentSchema = z.object({
  method: z.string().optional(),
  status: z.enum(['NOT_READY', 'READY', 'BOOKED', 'SHIPPED', 'DELIVERED']).default('NOT_READY'),
  qty: z.number().int().nonnegative().default(0),
  actualShippingDate: z.string().optional(),
  trackingNumber: z.string().optional(),
  carrier: z.string().optional(),
  awbNumber: z.string().optional(),
  finalDestination: z.string().optional(),
  notes: z.string().optional(),
});

/**
 * Create or update a shipment.
 *
 * Enforces the brief's rule that shipped quantity may not exceed produced
 * quantity without an admin override — and when overridden, the reason is
 * mandatory and lands in the audit trail.
 */
packingRouter.post('/:orderId/shipments', requirePermission('shipment:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = shipmentSchema.parse(req.body);

  const order = await prisma.order.findUnique({ where: { id: req.params.orderId }, include: ORDER_INCLUDE });
  if (!order) throw new NotFoundError('Order');

  const d = deriveOrder(order);
  const totals = ledgerTotals(d.cells);
  const producedQty = Math.max(totals[QtyLedger.IN_LINE] ?? 0, d.production.producedQty);
  const reason = getRequestContext()?.reason ?? null;
  const hasOverride = actor.permissions.includes('shipment:override');

  if (input.qty > 0) {
    assertShippableQuantity({
      shippedQty: input.qty,
      producedQty,
      hasOverridePermission: hasOverride,
      overrideReason: reason,
    });
  }

  const overrode = input.qty > producedQty;

  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id,
      method: input.method ?? order.shippingMethod,
      status: input.status,
      qty: input.qty,
      promisedShippingDate: order.promisedShippingDate,
      requiredDeliveryDate: order.requiredDeliveryDate,
      actualShippingDate: input.actualShippingDate ? new Date(input.actualShippingDate) : null,
      trackingNumber: input.trackingNumber,
      carrier: input.carrier,
      awbNumber: input.awbNumber,
      finalDestination: input.finalDestination,
      notes: input.notes,
      overrideApproved: overrode,
      overrideReason: overrode ? reason : null,
    },
  });

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'SHIPMENT_RECORDED',
    summary:
      `recorded a shipment: ${input.qty.toLocaleString()} pcs, ${input.status.toLowerCase().replace('_', ' ')}` +
      (overrode ? ` (override: ${reason})` : ''),
    entityType: 'Shipment', entityId: shipment.id,
    meta: { qty: input.qty, status: input.status, overrode },
  });

  await refreshOrderCache(order.id);
  res.status(201).json({ id: shipment.id, overrideApplied: overrode });
}));
