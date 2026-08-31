import { Router } from 'express';
import { z } from 'zod';
import {
  QtyLedger, LEDGER_LABEL, ChangeCategory, NotificationPriority,
  buildMatrix, computeCutMatrix, type QtyCell,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, ValidationError } from '../errors.js';
import {
  getOrderDetail, listOrders, refreshOrderCache, ORDER_INCLUDE,
  buildOrderSummary, toTaskDto, deriveOrder,
} from '../services/order-service.js';
import { materialiseWorkflow } from '../services/workflow-service.js';
import { logActivity } from '../services/activity-service.js';
import { announceChange } from '../services/change-service.js';
import {
  normalisePoNumber, assertValidOrderDates, assertValidPercentage, assertValidQuantity,
} from '../services/rules.js';

export const ordersRouter = Router();
ordersRouter.use(authenticate);

// ── List ────────────────────────────────────────────────────────────────────

ordersRouter.get('/', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

  const { data, total } = await listOrders(
    {
      search: req.query.search as string,
      clientId: req.query.clientId as string,
      coordinatorId: req.query.coordinatorId as string,
      season: req.query.season as string,
      status: req.query.status as string,
      stage: req.query.stage as string,
      factoryId: req.query.factoryId as string,
      shippingMethod: req.query.shippingMethod as string,
      priority: req.query.priority as string,
      dueBefore: req.query.dueBefore as string,
      dueAfter: req.query.dueAfter as string,
      includeCancelled: req.query.includeCancelled === 'true',
    },
    page, pageSize,
  );

  res.json({ data, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
}));

/** Global search — the brief's section 37. Matches PO, name, style, client, coordinator, factory, external ref. */
ordersRouter.get('/search', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const q = (req.query.q as string)?.trim();
  if (!q || q.length < 2) return res.json({ data: [] });

  const orders = await prisma.order.findMany({
    where: {
      OR: [
        { poNumber: { contains: q, mode: 'insensitive' } },
        { orderName: { contains: q, mode: 'insensitive' } },
        { styleNumber: { contains: q, mode: 'insensitive' } },
        { externalReference: { contains: q, mode: 'insensitive' } },
        { client: { name: { contains: q, mode: 'insensitive' } } },
        { coordinator: { name: { contains: q, mode: 'insensitive' } } },
        { factory: { name: { contains: q, mode: 'insensitive' } } },
      ],
    },
    include: ORDER_INCLUDE,
    take: 10,
  });

  res.json({ data: orders.map((o) => buildOrderSummary(o)) });
}));

// ── Read one ────────────────────────────────────────────────────────────────

ordersRouter.get('/:id', requirePermission('order:read'), asyncHandler(async (req, res) => {
  res.json(await getOrderDetail(req.params.id));
}));

// ── Create ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
  poNumber: z.string().min(1),
  orderName: z.string().min(1),
  season: z.string().min(1),
  clientId: z.string().min(1),
  itemType: z.string().optional(),
  gender: z.string().optional(),
  styleNumber: z.string().optional(),
  fit: z.string().optional(),
  blockPattern: z.string().optional(),
  fabric: z.string().optional(),
  shippingMethod: z.string().optional(),
  pricePerPieceUsd: z.number().nonnegative().optional(),
  cutPercentage: z.number().default(0.05),
  accessoryPercentage: z.number().default(0.05),
  poDate: z.string().optional(),
  promisedShippingDate: z.string().optional(),
  requiredDeliveryDate: z.string().optional(),
  factoryId: z.string().optional(),
  externalFactoryId: z.string().optional(),
  coordinatorId: z.string().optional(),
  outsideWorkManagerId: z.string().optional(),
  externalReference: z.string().optional(),
  externalWorkSort: z.string().optional(),
  externalWorkType: z.string().optional(),
  shippingAddress: z.string().optional(),
  billingAddress: z.string().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  colors: z.array(z.object({ colorId: z.string(), productName: z.string().optional() })).default([]),
  sizes: z.array(z.string()).default([]),
  /** quantities[colorId][sizeId] = qty */
  quantities: z.record(z.record(z.number().int().nonnegative())).default({}),
  notes: z.object({
    general: z.string().optional(), spread: z.string().optional(), cut: z.string().optional(),
    packing: z.string().optional(), external: z.string().optional(),
  }).optional(),
});

ordersRouter.post('/', requirePermission('order:create'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = createSchema.parse(req.body);

  const poNumber = normalisePoNumber(input.poNumber);
  assertValidOrderDates(input);
  assertValidPercentage(input.cutPercentage, 'Cut percentage');
  assertValidPercentage(input.accessoryPercentage, 'Accessory percentage');

  const existing = await prisma.order.findUnique({ where: { poNumber } });
  if (existing) throw new ValidationError(`PO ${poNumber} already exists.`, { orderId: existing.id });

  const poDate = input.poDate ? new Date(input.poDate) : new Date();
  const shipDate = input.promisedShippingDate
    ? new Date(input.promisedShippingDate)
    : new Date(poDate.getTime() + 30 * 86_400_000);

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        poNumber,
        orderName: input.orderName,
        season: input.season,
        clientId: input.clientId,
        itemType: input.itemType,
        gender: input.gender,
        styleNumber: input.styleNumber,
        fit: input.fit,
        blockPattern: input.blockPattern,
        fabric: input.fabric,
        shippingMethod: input.shippingMethod,
        pricePerPieceUsd: input.pricePerPieceUsd,
        cutPercentage: input.cutPercentage,
        accessoryPercentage: input.accessoryPercentage,
        poDate,
        promisedShippingDate: shipDate,
        requiredDeliveryDate: input.requiredDeliveryDate ? new Date(input.requiredDeliveryDate) : shipDate,
        factoryId: input.factoryId,
        externalFactoryId: input.externalFactoryId,
        coordinatorId: input.coordinatorId,
        outsideWorkManagerId: input.outsideWorkManagerId,
        externalReference: input.externalReference,
        externalWorkSort: input.externalWorkSort,
        externalWorkType: input.externalWorkType,
        shippingAddress: input.shippingAddress,
        billingAddress: input.billingAddress,
        priority: input.priority,
      },
    });

    // Axes
    for (const [i, c] of input.colors.entries()) {
      await tx.orderColor.create({
        data: { orderId: created.id, colorId: c.colorId, productName: c.productName, position: i },
      });
    }
    for (const [i, sizeId] of input.sizes.entries()) {
      await tx.orderSize.create({ data: { orderId: created.id, sizeId, position: i } });
    }

    // Quantities
    const orderColors = await tx.orderColor.findMany({ where: { orderId: created.id } });
    const orderSizes = await tx.orderSize.findMany({ where: { orderId: created.id } });
    const colorByRef = new Map(orderColors.map((c) => [c.colorId, c.id]));
    const sizeByRef = new Map(orderSizes.map((s) => [s.sizeId, s.id]));

    const rows: Array<{ orderId: string; orderColorId: string; orderSizeId: string; ledger: 'ORDER'; qty: number }> = [];
    for (const [colorRefId, sizeMap] of Object.entries(input.quantities)) {
      const orderColorId = colorByRef.get(colorRefId);
      if (!orderColorId) continue;
      for (const [sizeRefId, qty] of Object.entries(sizeMap)) {
        const orderSizeId = sizeByRef.get(sizeRefId);
        if (!orderSizeId || qty <= 0) continue;
        assertValidQuantity(qty, 'Order quantity');
        rows.push({ orderId: created.id, orderColorId, orderSizeId, ledger: 'ORDER', qty });
      }
    }
    if (rows.length > 0) await tx.stageQuantity.createMany({ data: rows });

    // Notes
    if (input.notes) {
      const kinds = [
        ['GENERAL', input.notes.general], ['SPREAD', input.notes.spread], ['CUT', input.notes.cut],
        ['PACKING', input.notes.packing], ['EXTERNAL', input.notes.external],
      ] as const;
      for (const [kind, body] of kinds) {
        if (body?.trim()) await tx.orderNote.create({ data: { orderId: created.id, kind, body } });
      }
    }

    // The 27 tasks from Progress Status.
    await materialiseWorkflow(tx, created.id, {
      poDate, promisedShippingDate: shipDate,
      coordinatorId: input.coordinatorId, outsideWorkManagerId: input.outsideWorkManagerId,
    });

    await logActivity({
      orderId: created.id, actorId: actor.id, actorName: actor.name,
      action: 'ORDER_CREATED', summary: `created order ${poNumber} — ${input.orderName}`,
      entityType: 'Order', entityId: created.id,
    }, tx);

    return created;
  });

  await refreshOrderCache(order.id);
  res.status(201).json(await getOrderDetail(order.id));
}));

// ── Update ──────────────────────────────────────────────────────────────────

const updateSchema = createSchema.partial().omit({ poNumber: true, colors: true, sizes: true, quantities: true });

ordersRouter.patch('/:id', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = updateSchema.parse(req.body);

  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) throw new NotFoundError('Order');

  assertValidOrderDates({
    poDate: input.poDate ?? order.poDate,
    promisedShippingDate: input.promisedShippingDate ?? order.promisedShippingDate,
    requiredDeliveryDate: input.requiredDeliveryDate ?? order.requiredDeliveryDate,
  });
  if (input.cutPercentage != null) assertValidPercentage(input.cutPercentage, 'Cut percentage');
  if (input.accessoryPercentage != null) assertValidPercentage(input.accessoryPercentage, 'Accessory percentage');

  const { notes, ...scalar } = input;

  await prisma.order.update({
    where: { id: order.id },
    data: {
      ...scalar,
      poDate: input.poDate ? new Date(input.poDate) : undefined,
      promisedShippingDate: input.promisedShippingDate ? new Date(input.promisedShippingDate) : undefined,
      requiredDeliveryDate: input.requiredDeliveryDate ? new Date(input.requiredDeliveryDate) : undefined,
    },
  });

  if (notes) {
    const kinds = [
      ['GENERAL', notes.general], ['SPREAD', notes.spread], ['CUT', notes.cut],
      ['PACKING', notes.packing], ['EXTERNAL', notes.external],
    ] as const;
    for (const [kind, body] of kinds) {
      if (body === undefined) continue;
      await prisma.orderNote.upsert({
        where: { orderId_kind: { orderId: order.id, kind } },
        create: { orderId: order.id, kind, body: body ?? '' },
        update: { body: body ?? '' },
      });
    }
  }

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'ORDER_UPDATED', summary: `updated order details`,
    entityType: 'Order', entityId: order.id,
  });

  await refreshOrderCache(order.id);
  res.json(await getOrderDetail(order.id));
}));

// ── Quantity matrix ─────────────────────────────────────────────────────────

ordersRouter.get('/:id/matrix', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.id }, { poNumber: req.params.id }] },
    include: ORDER_INCLUDE,
  });
  if (!order) throw new NotFoundError('Order');

  const d = deriveOrder(order);
  const matrices: Record<string, unknown> = {};
  for (const ledger of Object.values(QtyLedger)) {
    matrices[ledger] = buildMatrix(d.cells, d.colors, d.sizes, ledger);
  }

  res.json({
    colors: order.colors.map((c) => ({ id: c.id, name: c.color.name, hex: c.color.hex, position: c.position })),
    sizes: order.sizes.map((s) => ({ id: s.id, name: s.size.name, position: s.position })),
    matrices,
    totals: d.totals,
  });
}));

const setQtySchema = z.object({
  ledger: z.enum(['ORDER', 'STOCK', 'CUT', 'IN_LINE', 'OUT_LINE', 'PACKED', 'SHIPPED', 'SECOND_DEGREE']),
  cells: z.array(z.object({
    orderColorId: z.string(),
    orderSizeId: z.string(),
    qty: z.number().int().nonnegative(),
  })),
});

ordersRouter.put('/:id/matrix', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const { ledger, cells } = setQtySchema.parse(req.body);

  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) throw new NotFoundError('Order');

  for (const c of cells) assertValidQuantity(c.qty, 'Quantity');

  // The matrix is written cell by cell with `upsert`, which the audit
  // middleware does not intercept — and forty cell events would be the wrong
  // story anyway. The change a person cares about is the ledger total, so it
  // is read before and after and announced once.
  const totalBefore = await ledgerTotal(order.id, ledger);

  await prisma.$transaction(
    cells.map((c) =>
      prisma.stageQuantity.upsert({
        where: {
          orderId_orderColorId_orderSizeId_ledger: {
            orderId: order.id, orderColorId: c.orderColorId, orderSizeId: c.orderSizeId, ledger,
          },
        },
        create: { orderId: order.id, orderColorId: c.orderColorId, orderSizeId: c.orderSizeId, ledger, qty: c.qty },
        update: { qty: c.qty },
      }),
    ),
  );

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'QUANTITIES_UPDATED',
    summary: `updated ${cells.length} ${ledger.toLowerCase().replace('_', '-')} quantit${cells.length === 1 ? 'y' : 'ies'}`,
    entityType: 'StageQuantity', entityId: order.id, meta: { ledger, cellCount: cells.length },
  });

  const totalAfter = await ledgerTotal(order.id, ledger);
  if (totalAfter !== totalBefore) {
    await announceChange({
      entityType: 'Order',
      entityId: order.id,
      action: 'UPDATE',
      category: ChangeCategory.ORDER,
      summary: `Order PO ${order.poNumber}: ${LEDGER_LABEL[ledger as QtyLedger].toLowerCase()} quantity changed`,
      subject: `PO ${order.poNumber}`,
      priority: NotificationPriority.NORMAL,
      orderId: order.id,
      link: `/orders/${order.id}?tab=quantity`,
      fields: [{
        label: `${LEDGER_LABEL[ledger as QtyLedger]} quantity`,
        oldValue: totalBefore.toLocaleString('en-GB'),
        newValue: totalAfter.toLocaleString('en-GB'),
      }],
      actorId: actor.id,
      actorName: actor.name,
    });
  }

  await refreshOrderCache(order.id);
  res.json(await getOrderDetail(order.id));
}));

/** The order's total for one ledger, for before/after comparison. */
async function ledgerTotal(orderId: string, ledger: string): Promise<number> {
  const agg = await prisma.stageQuantity.aggregate({
    where: { orderId, ledger: ledger as never },
    _sum: { qty: true },
  });
  return agg._sum.qty ?? 0;
}

/**
 * Generate the CUT ledger from ORDER − STOCK × (1 + cut%).
 * This is the Cut Order sheet's entire purpose, as one button.
 */
ordersRouter.post('/:id/matrix/generate-cut', requirePermission('cutting:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
  if (!order) throw new NotFoundError('Order');

  const d = deriveOrder(order);
  const cutPct = Number(order.cutPercentage.toString());
  const cutCells: QtyCell[] = computeCutMatrix(d.cells, d.colors, d.sizes, cutPct);

  await prisma.$transaction(async (tx) => {
    await tx.stageQuantity.deleteMany({ where: { orderId: order.id, ledger: 'CUT' } });
    if (cutCells.length > 0) {
      await tx.stageQuantity.createMany({
        data: cutCells.map((c) => ({
          orderId: order.id, orderColorId: c.colorId, orderSizeId: c.sizeId, ledger: 'CUT' as const, qty: c.qty,
        })),
      });
    }
  });

  const total = cutCells.reduce((a, c) => a + c.qty, 0);
  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'CUT_ORDER_GENERATED',
    summary: `generated the cut order — ${total.toLocaleString()} pieces at ${(cutPct * 100).toFixed(1)}% allowance`,
    entityType: 'Order', entityId: order.id, meta: { total, cutPct },
  });

  // Written with deleteMany + createMany, neither of which the middleware
  // intercepts — and the news is the new cut total, not four hundred rows.
  const cutBefore = d.totals[QtyLedger.CUT] ?? 0;
  if (total !== cutBefore) {
    await announceChange({
      entityType: 'Order',
      entityId: order.id,
      action: 'UPDATE',
      category: ChangeCategory.ORDER,
      summary: `Order PO ${order.poNumber}: cut order regenerated`,
      subject: `PO ${order.poNumber}`,
      priority: NotificationPriority.NORMAL,
      orderId: order.id,
      link: `/orders/${order.id}?tab=quantity`,
      fields: [
        {
          label: 'Cut quantity',
          oldValue: cutBefore > 0 ? cutBefore.toLocaleString('en-GB') : null,
          newValue: total.toLocaleString('en-GB'),
        },
        {
          label: 'Cut allowance',
          oldValue: null,
          newValue: `${(cutPct * 100).toFixed(1)}%`,
        },
      ],
      actorId: actor.id,
      actorName: actor.name,
    });
  }

  await refreshOrderCache(order.id);
  res.json(await getOrderDetail(order.id));
}));

// ── Sub-resources ───────────────────────────────────────────────────────────

ordersRouter.get('/:id/tasks', requirePermission('task:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.id }, { poNumber: req.params.id }] },
    include: ORDER_INCLUDE,
  });
  if (!order) throw new NotFoundError('Order');
  res.json({ data: order.tasks.map((t) => toTaskDto(t, order)) });
}));

ordersRouter.get('/:id/activity', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const logs = await prisma.activityLog.findMany({
    where: { orderId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json({
    data: logs.map((l) => ({
      id: l.id, orderId: l.orderId, actorName: l.actorName,
      actorInitials: l.actorName.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase(),
      action: l.action, summary: l.summary, entityType: l.entityType, entityId: l.entityId,
      meta: l.meta, createdAt: l.createdAt.toISOString(),
    })),
  });
}));

ordersRouter.get('/:id/audit-trail', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const rows = await prisma.auditTrail.findMany({
    where: { orderId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    data: rows.map((r) => ({
      id: r.id, entityType: r.entityType, entityId: r.entityId, field: r.field,
      oldValue: r.oldValue, newValue: r.newValue, actorName: r.actorName,
      reason: r.reason, createdAt: r.createdAt.toISOString(),
    })),
  });
}));
