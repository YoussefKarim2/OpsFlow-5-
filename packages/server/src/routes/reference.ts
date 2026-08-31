/**
 * Reference data, users, clients, factories, attachments and reports.
 *
 * The lookups here are the workbook's `Data-Base` sheet, which was already a
 * reference-data table — 95 fabrics, 90 colours, 30 item types, 37 positions,
 * 24 external work types. It maps to lookup tables with no transformation.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ROLE_LABEL, OrderStatus, QtyLedger } from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { ORDER_INCLUDE, buildOrderSummary, deriveOrder } from '../services/order-service.js';
import { storage } from '../services/storage/index.js';

export const referenceRouter = Router();
referenceRouter.use(authenticate);

// ── Lookups ─────────────────────────────────────────────────────────────────

referenceRouter.get('/lookups', asyncHandler(async (_req, res) => {
  const [colors, sizes, values, clients, factories, users] = await Promise.all([
    prisma.refColor.findMany({ where: { active: true }, orderBy: { position: 'asc' } }),
    prisma.refSize.findMany({ where: { active: true }, orderBy: { position: 'asc' } }),
    prisma.refValue.findMany({ where: { active: true }, orderBy: [{ kind: 'asc' }, { position: 'asc' }] }),
    prisma.client.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    prisma.factory.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    // Names and departments only. This endpoint is open to every signed-in
    // user because task assignment needs it; email addresses are not part of
    // assigning a task, so they are not here. The full account list lives
    // behind `user:manage`.
    prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, department: true, role: { select: { key: true, label: true } } },
      orderBy: { name: 'asc' },
    }),
  ]);

  const byKind: Record<string, Array<{ id: string; value: string; valueAr: string | null }>> = {};
  for (const v of values) {
    (byKind[v.kind] ??= []).push({ id: v.id, value: v.value, valueAr: v.valueAr });
  }

  res.json({
    colors: colors.map((c) => ({ id: c.id, name: c.name, hex: c.hex, position: c.position })),
    sizes: sizes.map((s) => ({ id: s.id, name: s.name, longName: s.longName, position: s.position })),
    values: byKind,
    clients: clients.map((c) => ({
      id: c.id, name: c.name, code: c.code,
      shippingAddress: c.shippingAddress, billingAddress: c.billingAddress,
    })),
    factories: factories.map((f) => ({ id: f.id, name: f.name, code: f.code, isExternal: f.isExternal })),
    users: users.map((u) => ({
      id: u.id, name: u.name, department: u.department,
      roleKey: u.role.key, roleLabel: u.role.label,
    })),
    roles: Object.entries(ROLE_LABEL).map(([key, label]) => ({ key, label })),
  });
}));

// ── Clients ─────────────────────────────────────────────────────────────────

referenceRouter.get('/clients', requirePermission('order:read'), asyncHandler(async (_req, res) => {
  const clients = await prisma.client.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { orders: true } } },
  });
  res.json({
    data: clients.map((c) => ({
      id: c.id, name: c.name, code: c.code, contactName: c.contactName, email: c.email, phone: c.phone,
      shippingAddress: c.shippingAddress, billingAddress: c.billingAddress,
      active: c.active, orderCount: c._count.orders,
    })),
  });
}));

const clientSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  contactName: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  shippingAddress: z.string().optional(),
  billingAddress: z.string().optional(),
  notes: z.string().optional(),
});

referenceRouter.post('/clients', requirePermission('client:manage'), asyncHandler(async (req, res) => {
  const input = clientSchema.parse(req.body);
  const existing = await prisma.client.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' } } });
  if (existing) throw new ValidationError(`A client named "${input.name}" already exists.`);
  const client = await prisma.client.create({ data: { ...input, email: input.email || null } });
  res.status(201).json({ id: client.id });
}));

referenceRouter.patch('/clients/:id', requirePermission('client:manage'), asyncHandler(async (req, res) => {
  const input = clientSchema.partial().parse(req.body);
  await prisma.client.update({ where: { id: req.params.id }, data: { ...input, email: input.email || undefined } });
  res.json({ ok: true });
}));

// ── Factories ───────────────────────────────────────────────────────────────

referenceRouter.get('/factories', requirePermission('order:read'), asyncHandler(async (_req, res) => {
  const factories = await prisma.factory.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { orders: true, externalOperations: true } } },
  });
  res.json({
    data: factories.map((f) => ({
      id: f.id, name: f.name, code: f.code, address: f.address, contact: f.contact, phone: f.phone,
      isExternal: f.isExternal, active: f.active,
      orderCount: f._count.orders, externalOpCount: f._count.externalOperations,
    })),
  });
}));

const factorySchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  address: z.string().optional(),
  contact: z.string().optional(),
  phone: z.string().optional(),
  isExternal: z.boolean().default(false),
});

referenceRouter.post('/factories', requirePermission('factory:manage'), asyncHandler(async (req, res) => {
  const input = factorySchema.parse(req.body);
  const factory = await prisma.factory.create({ data: input });
  res.status(201).json({ id: factory.id });
}));

// ── Users ───────────────────────────────────────────────────────────────────

/**
 * The account list.
 *
 * Behind `user:manage`, not `order:read`. It was the latter, which meant every
 * authenticated user in the factory could read every colleague's email address
 * and last sign-in time. The directory an ordinary user genuinely needs — names
 * and departments, for assigning a task — is `/lookups` above, and it carries
 * neither.
 *
 * Account *management* lives in routes/admin.ts; this endpoint is read-only and
 * kept here so existing callers keep working.
 */
referenceRouter.get('/users', requirePermission('user:manage'), asyncHandler(async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { name: 'asc' },
    include: {
      role: true,
      _count: { select: { assignedTasks: { where: { status: { not: 'COMPLETED' } } }, coordinatedOrders: true } },
    },
  });
  res.json({
    data: users.map((u) => ({
      id: u.id, name: u.name, email: u.email, department: u.department,
      roleKey: u.role.key, roleLabel: u.role.label, active: u.active,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      openTaskCount: u._count.assignedTasks, orderCount: u._count.coordinatedOrders,
    })),
  });
}));

// ── Attachments ─────────────────────────────────────────────────────────────

referenceRouter.get('/orders/:orderId/attachments', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const attachments = await prisma.attachment.findMany({
    where: { orderId: req.params.orderId },
    include: { uploadedBy: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    data: await Promise.all(attachments.map(async (a) => ({
      id: a.id, fileName: a.fileName, documentType: a.documentType, mimeType: a.mimeType,
      sizeBytes: a.sizeBytes, version: a.version, stageKey: a.stageKey,
      uploadedByName: a.uploadedBy.name, createdAt: a.createdAt.toISOString(),
      downloadUrl: await storage.url(a.storageKey),
    }))),
  });
}));

/**
 * Stream a locally-stored file.
 *
 * The key must correspond to a known attachment and the caller must hold
 * `order:read`. Previously any authenticated user could pass any storage key
 * and receive whatever was behind it, including import uploads that have no
 * attachment row at all — a signed-in user could read a file simply by knowing
 * or guessing its key.
 */
referenceRouter.get('/files/:key', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const attachment = await prisma.attachment.findFirst({ where: { storageKey: key } });
  if (!attachment) throw new NotFoundError('File');

  const buffer = await storage.get(key);
  res.setHeader('Content-Type', attachment.mimeType);
  // Quoting is not enough on its own — a filename containing a quote would
  // break out of the header, so the raw quotes are stripped.
  res.setHeader('Content-Disposition', `inline; filename="${attachment.fileName.replace(/["\\]/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buffer);
}));

// ── Reports — the brief's section 36 ────────────────────────────────────────

referenceRouter.get('/reports/:kind', requirePermission('report:read'), asyncHandler(async (req, res) => {
  const kind = req.params.kind;
  const today = new Date();

  const where = {
    cancelled: false,
    ...(req.query.from || req.query.to
      ? {
          requiredDeliveryDate: {
            ...(req.query.from ? { gte: new Date(req.query.from as string) } : {}),
            ...(req.query.to ? { lte: new Date(req.query.to as string) } : {}),
          },
        }
      : {}),
  };

  const orders = await prisma.order.findMany({ where, include: ORDER_INCLUDE });
  const summaries = orders.map((o) => buildOrderSummary(o, today));

  /** Group summaries by a key and aggregate the numbers that matter. */
  const groupBy = (fn: (s: (typeof summaries)[number]) => string) => {
    const map = new Map<string, typeof summaries>();
    for (const s of summaries) {
      const k = fn(s) || 'Unassigned';
      (map.get(k) ?? map.set(k, []).get(k)!).push(s);
    }
    return [...map.entries()].map(([key, rows]) => ({
      key,
      orderCount: rows.length,
      totalQty: rows.reduce((a, r) => a + r.orderQty, 0),
      producedQty: rows.reduce((a, r) => a + r.producedQty, 0),
      shippedQty: rows.reduce((a, r) => a + r.shippedQty, 0),
      lateCount: rows.filter((r) => r.daysRemaining != null && r.daysRemaining < 0).length,
      avgProgress: Math.round(rows.reduce((a, r) => a + r.progressPct, 0) / rows.length),
      criticalAlerts: rows.reduce((a, r) => a + r.alertCounts.critical, 0),
    })).sort((a, b) => b.orderCount - a.orderCount);
  };

  switch (kind) {
    case 'by-client':      return res.json({ kind, rows: groupBy((s) => s.clientName) });
    case 'by-coordinator': return res.json({ kind, rows: groupBy((s) => s.coordinatorName ?? '') });
    case 'by-factory':     return res.json({ kind, rows: groupBy((s) => s.factoryName ?? '') });
    case 'by-season':      return res.json({ kind, rows: groupBy((s) => s.season) });
    case 'by-status':      return res.json({ kind, rows: groupBy((s) => s.status) });

    case 'late-orders':
      return res.json({
        kind,
        rows: summaries
          .filter((s) => (s.daysRemaining != null && s.daysRemaining < 0) || s.status === OrderStatus.PRODUCTION_DELAYED)
          .sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0)),
      });

    case 'material-shortages': {
      const rows: unknown[] = [];
      for (const o of orders) {
        const d = deriveOrder(o, today);
        if (!d.bom || d.bom.shortItems === 0) continue;
        rows.push({
          orderId: o.id, poNumber: o.poNumber, orderName: o.orderName, clientName: o.client.name,
          shortItems: d.bom.shortItems, totalItems: d.bom.totalItems,
          coveragePct: d.bom.overallCoveragePct,
          worst: d.bom.topShortages.map((t) => ({
            item: t.item, color: t.color, shortQty: t.shortQty, unit: t.unit,
          })),
        });
      }
      return res.json({ kind, rows });
    }

    case 'quality-failures': {
      const audits = await prisma.qualityAudit.findMany({
        where: { result: 'FAIL', order: where },
        include: { order: { select: { poNumber: true, orderName: true, client: { select: { name: true } } } }, defects: true },
        orderBy: { inspectionDate: 'desc' },
      });
      return res.json({
        kind,
        rows: audits.map((a) => ({
          auditId: a.id, poNumber: a.order.poNumber, orderName: a.order.orderName,
          clientName: a.order.client.name, inspectionDate: a.inspectionDate.toISOString(),
          availableQty: a.availableQty, sampleSize: a.sampleSize,
          totalDefects: a.defects.reduce((s, d) => s + d.qty, 0),
          correctiveActionClosed: a.correctiveActionClosed,
          defects: a.defects.map((d) => ({ category: d.category, qty: d.qty })),
        })),
      });
    }

    case 'production-performance': {
      const rows = orders.map((o) => {
        const d = deriveOrder(o, today);
        return {
          poNumber: o.poNumber, orderName: o.orderName,
          orderQty: d.totals[QtyLedger.ORDER] ?? 0,
          cutQty: d.totals[QtyLedger.CUT] ?? 0,
          producedQty: d.production.producedQty,
          remainingQty: d.production.remainingQty,
          dailyRate: d.production.dailyRate,
          requiredDailyRate: d.production.requiredDailyRate,
          projectedCompletion: d.production.projectedCompletion?.toISOString() ?? null,
          slipDays: d.production.slipDays,
          isBehindSchedule: d.production.isBehindSchedule,
        };
      });
      return res.json({ kind, rows });
    }

    case 'costing': {
      const rows = orders.map((o) => {
        const d = deriveOrder(o, today);
        return {
          poNumber: o.poNumber, orderName: o.orderName, clientName: o.client.name,
          sellPriceUsd: d.costing?.sellPriceUsd ?? null,
          unitActualCostUsd: d.costing?.unitActualCostUsd ?? null,
          profitPerUnitUsd: d.costing?.profitPerUnitUsd ?? null,
          profitPct: d.costing?.profitPct ?? null,
          totalCostUsd: d.costing?.totalCostUsd ?? null,
          totalProfitUsd: d.costing?.totalProfitUsd ?? null,
        };
      });
      return res.json({ kind, rows });
    }

    default:
      throw new NotFoundError(`Report "${kind}"`);
  }
}));
