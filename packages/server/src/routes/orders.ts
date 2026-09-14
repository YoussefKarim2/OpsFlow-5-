import { Router } from 'express';
import { z } from 'zod';
import {
  QtyLedger, LEDGER_LABEL, ChangeCategory, NotificationPriority,
  buildMatrix, computeCutMatrix, isSignificantQtyChange, type QtyCell,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import {
  relationId, requiredRelationId, optionalDate, optionalNumber, shortText, longText, money,
} from '../util/form-input.js';
import { storage } from '../services/storage/index.js';
import { authenticate, requirePermission, requireSuperAdmin, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import {
  getOrderDetail, listOrders, refreshOrderCache, ORDER_INCLUDE,
  buildOrderSummary, toTaskDto, deriveOrder, type FullOrder,
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
  poNumber: z.string().min(1).max(64),
  orderName: z.string().min(1).max(200),
  season: z.string().min(1).max(200),
  clientId: z.string().min(1),
  itemType: shortText(),
  gender: shortText(),
  styleNumber: shortText(),
  fit: shortText(),
  blockPattern: shortText(),
  fabric: shortText(),
  // External Order_Ex.Op shows three fabric slots and both supplier dates;
  // all five were already columns and none of them were writable.
  fabric2: shortText().nullable(),
  fabric3: shortText().nullable(),
  fabricDeliveryToSupplier: z.string().optional().nullable(),
  supplierDeliveryDate: z.string().optional().nullable(),
  shippingMethod: shortText(),
  pricePerPieceUsd: money(),
  cutPercentage: optionalNumber(z.number()).default(0.05),
  accessoryPercentage: optionalNumber(z.number()).default(0.05),
  poDate: optionalDate,
  promisedShippingDate: optionalDate,
  requiredDeliveryDate: optionalDate,
  factoryId: relationId,
  externalFactoryId: relationId,
  coordinatorId: relationId,
  outsideWorkManagerId: relationId,
  externalReference: shortText(),
  externalWorkSort: shortText(),
  externalWorkType: shortText(),
  shippingAddress: longText(2000),
  billingAddress: longText(2000),
  /// The factory's own PO date, distinct from the customer's.
  internalPoDate: z.string().optional().nullable(),
  /// Null is "nobody has said yet", which is not the same as "no".
  productionSample: z.boolean().optional().nullable(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  colors: z.array(z.object({ colorId: z.string(), productName: z.string().optional() })).default([]),
  sizes: z.array(z.string()).default([]),
  /** quantities[colorId][sizeId] = qty */
  quantities: z.record(z.record(z.number().int().nonnegative())).default({}),
  notes: z.object({
    general: longText(), spread: longText(), cut: longText(),
    packing: longText(), external: longText(),
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
        internalPoDate: input.internalPoDate ? new Date(input.internalPoDate) : null,
        productionSample: input.productionSample ?? null,
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

/**
 * Everything on the order may be edited, the PO number included.
 *
 * It was withheld because it is the order's identity and half the codebase
 * looks orders up by it. That is a reason to check the change, not to refuse it
 * — a PO typed wrong on the day it was raised is otherwise wrong forever, and
 * people worked around it by deleting the order and starting again.
 *
 * `colors`, `sizes` and `quantities` stay out: they are the quantity matrix,
 * which has its own route because changing it moves ledgers.
 */
const updateSchema = createSchema
  .partial()
  .omit({ colors: true, sizes: true, quantities: true })
  // A blank client on an edit means the form had nothing to offer, not that the
  // order should lose its customer. See `requiredRelationId`.
  .extend({ clientId: requiredRelationId });

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

  // The PO number is unique and is how most of the application finds an order.
  // Checked here rather than left to the database, so a clash reads as a
  // sentence about another order instead of a constraint violation.
  if (input.poNumber != null && input.poNumber !== order.poNumber) {
    const wanted = normalisePoNumber(input.poNumber);
    const clash = await prisma.order.findUnique({ where: { poNumber: wanted }, select: { id: true } });
    if (clash && clash.id !== order.id) {
      throw new ConflictError(`PO ${wanted} already belongs to another order.`);
    }
    input.poNumber = wanted;
  }

  const { notes, ...scalar } = input;

  await prisma.order.update({
    where: { id: order.id },
    data: {
      ...scalar,
      poDate: input.poDate ? new Date(input.poDate) : undefined,
      promisedShippingDate: input.promisedShippingDate ? new Date(input.promisedShippingDate) : undefined,
      requiredDeliveryDate: input.requiredDeliveryDate ? new Date(input.requiredDeliveryDate) : undefined,
      // Present-and-empty clears the date; absent leaves it alone. A field the
      // form did not send must not be wiped by the form not sending it.
      internalPoDate: input.internalPoDate === undefined
        ? undefined
        : input.internalPoDate ? new Date(input.internalPoDate) : null,
      fabricDeliveryToSupplier: input.fabricDeliveryToSupplier === undefined
        ? undefined
        : input.fabricDeliveryToSupplier ? new Date(input.fabricDeliveryToSupplier) : null,
      supplierDeliveryDate: input.supplierDeliveryDate === undefined
        ? undefined
        : input.supplierDeliveryDate ? new Date(input.supplierDeliveryDate) : null,
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

  // The allowance is the cut order's third input, alongside the order quantity
  // and the finished stock. Moving it and leaving the sheet on the old figure
  // would be the same staleness the quantity grid guards against.
  if (input.cutPercentage != null && Number(order.cutPercentage.toString()) !== input.cutPercentage) {
    await refreshCutOrder(order.id);
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

/**
 * The ledgers the cut order is calculated from. Writing any of these leaves a
 * stored cut order out of date, so it is recalculated.
 *
 * CUT itself is deliberately absent: it is the output, it is read-only in the
 * app, and refreshing it in response to its own write would be a rewrite
 * chasing a rewrite.
 */
export const CUT_ORDER_INPUT_LEDGERS: readonly string[] = [QtyLedger.ORDER, QtyLedger.STOCK];

/**
 * Recalculate the CUT ledger from the order, its finished stock and its
 * allowance, and store the result. Returns the new cut total.
 *
 * The cut order is entirely derived — it is editable nowhere in the app — so a
 * rewrite here destroys nothing anybody typed.
 */
async function writeCutOrder(order: FullOrder): Promise<{ total: number; before: number }> {
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

  return { total: cutCells.reduce((a, c) => a + c.qty, 0), before: d.totals[QtyLedger.CUT] ?? 0 };
}

/**
 * Refresh a cut order that already exists, after one of its inputs moved.
 *
 * Recording finished stock and then finding the cut order unchanged is the
 * complaint this exists to answer: the figure had been calculated once and
 * stored, and nothing recalculated it.
 *
 * Only touches an order that has a cut order already. Generating one the first
 * time is a deliberate act — the Cut Order step has a button for it — and
 * conjuring one because somebody recorded stock would make that step look
 * finished before anyone had been near it. Returns null when there was nothing
 * to refresh.
 */
async function refreshCutOrder(orderId: string): Promise<number | null> {
  const existing = await prisma.stageQuantity.count({ where: { orderId, ledger: 'CUT' } });
  if (existing === 0) return null;

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  if (!order) return null;

  const { total } = await writeCutOrder(order);
  return total;
}

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

  // The cut order is calculated from the order quantity, the finished stock and
  // the allowance. Change any of those and the stored figure is out of date, so
  // it is rebuilt here rather than waiting for someone to press the button
  // again — which is how stock came to be recorded and subtracted from nothing.
  let refreshedCut: number | null = null;
  if (CUT_ORDER_INPUT_LEDGERS.includes(ledger)) {
    refreshedCut = await refreshCutOrder(order.id);
  }

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'QUANTITIES_UPDATED',
    summary: `updated ${cells.length} ${ledger.toLowerCase().replace('_', '-')} quantit${cells.length === 1 ? 'y' : 'ies'}`
      + (refreshedCut !== null ? `; cut order recalculated to ${refreshedCut.toLocaleString()}` : ''),
    entityType: 'StageQuantity', entityId: order.id, meta: { ledger, cellCount: cells.length },
  });

  const totalAfter = await ledgerTotal(order.id, ledger);
  // "A significant production quantity changes" — a one-piece correction is
  // routine editing, not news; a swing of a tenth or more is.
  if (isSignificantQtyChange(totalBefore, totalAfter)) {
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

  const cutPct = Number(order.cutPercentage.toString());
  const { total, before: cutBefore } = await writeCutOrder(order);
  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'CUT_ORDER_GENERATED',
    summary: `generated the cut order — ${total.toLocaleString()} pieces at ${(cutPct * 100).toFixed(1)}% allowance`,
    entityType: 'Order', entityId: order.id, meta: { total, cutPct },
  });

  // Written with deleteMany + createMany, neither of which the middleware
  // intercepts — and the news is the new cut total, not four hundred rows.
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

/**
 * Delete an order, and everything filed under it.
 *
 * Super admins only, and deliberately not behind a permission: permissions are
 * a table an administrator can edit, and this is the one action with no undo.
 * `requireSuperAdmin` consults the named list in the environment instead, so a
 * role misconfiguration cannot hand it to anybody.
 *
 * The database cascades the rows — quantities, BOM, markers, tasks, approvals,
 * attachments, the lot. What it cannot cascade is the *file bytes*, which live
 * under their own keys in the storage driver with no foreign key pointing at
 * them; deleting the order would leave them behind forever, taking up space in
 * the backups with nothing left that could ever reference them. So they go
 * first, while the rows that name them still exist.
 *
 * The PO number must be typed back to confirm. An order is months of work and
 * a mis-click is not a good enough reason to lose it.
 */
ordersRouter.delete('/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.id }, { poNumber: req.params.id }] },
    select: { id: true, poNumber: true, orderName: true },
  });
  if (!order) throw new NotFoundError('Order');

  const confirm = String((req.body as { confirm?: unknown } | undefined)?.confirm ?? '').trim();
  if (confirm !== order.poNumber) {
    throw new ValidationError(
      `Type the PO number "${order.poNumber}" to confirm. This cannot be undone.`,
    );
  }

  const files = await prisma.attachment.findMany({
    where: { orderId: order.id },
    select: { storageKey: true },
  });
  // One failed delete must not abandon the rest: a key already gone is not a
  // reason to keep the order.
  for (const f of files) await storage.delete(f.storageKey).catch(() => undefined);

  await prisma.order.delete({ where: { id: order.id } });

  // Logged against no order, because there is no longer an order to log against
  // — the audit trail has to outlive the thing it describes.
  await logActivity({
    orderId: null,
    actorId: actor.id,
    actorName: actor.name,
    action: 'order.delete',
    summary: `deleted order ${order.poNumber}${order.orderName ? ` — ${order.orderName}` : ''}`
      + ` and ${files.length} attached file${files.length === 1 ? '' : 's'}`,
    entityType: 'Order',
    entityId: order.id,
  });

  res.status(204).end();
}));
