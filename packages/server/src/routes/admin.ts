/**
 * Administration — user management and the audit log.
 *
 * Two gates guard this router, and they are deliberately independent:
 *
 *   `requirePermission(...)` — the role must grant it.
 *   `requireSuperAdmin`      — the person must be one of the named few.
 *
 * A role misconfiguration cannot open the account-mutating endpoints, because
 * the second gate does not consult the permission table at all. Reading the
 * account list and the audit log needs only the first, so an administrator can
 * see what happened without being able to change who works here.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requirePermission, requireSuperAdmin, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import {
  listUsers, getUser, createUser, setUserActive, resetPassword,
  changeRole, setSuperAdmin, updateUserProfile, unlockUser, listRoles,
} from '../services/user-service.js';
import { SUPER_ADMIN_EMAILS } from '../config.js';

export const adminRouter = Router();
adminRouter.use(authenticate);

const DEPARTMENTS = [
  'COORDINATOR', 'FACTORY_MANAGER', 'PRODUCTION_MANAGER', 'CUTTING_MARKER', 'WAREHOUSE',
  'EXTERNAL_OPS', 'PACKING', 'QUALITY', 'FOLLOW_UP', 'FINANCE', 'ADMIN',
] as const;

// ── Users ───────────────────────────────────────────────────────────────────

adminRouter.get('/users', requirePermission('user:manage'), asyncHandler(async (_req, res) => {
  res.json({ data: await listUsers() });
}));

adminRouter.get('/users/:id', requirePermission('user:manage'), asyncHandler(async (req, res) => {
  res.json(await getUser(req.params.id));
}));

const createSchema = z.object({
  name: z.string().min(2, 'Enter the person’s full name.'),
  email: z.string().email('Enter a valid email address.'),
  // Optional: leaving it blank generates a single-use password instead, which
  // is the safer default and the one the UI offers first.
  password: z.string().min(10, 'Choose a password of at least 10 characters.').optional(),
  roleKey: z.string().min(1),
  department: z.enum(DEPARTMENTS),
  phone: z.string().optional(),
  isSuperAdmin: z.boolean().optional(),
});

adminRouter.post(
  '/users',
  requireSuperAdmin,
  requirePermission('user:create'),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    const input = createSchema.parse(req.body);
    const result = await createUser(actor, input);
    res.status(201).json(result);
  }),
);

const profileSchema = z.object({
  name: z.string().min(2).optional(),
  department: z.enum(DEPARTMENTS).optional(),
  phone: z.string().nullable().optional(),
});

adminRouter.patch(
  '/users/:id',
  requireSuperAdmin,
  requirePermission('user:create'),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    res.json(await updateUserProfile(actor, req.params.id, profileSchema.parse(req.body)));
  }),
);

const disableSchema = z.object({ reason: z.string().max(500).optional() });

adminRouter.post(
  '/users/:id/disable',
  requireSuperAdmin,
  requirePermission('user:disable'),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    const { reason } = disableSchema.parse(req.body ?? {});
    res.json(await setUserActive(actor, req.params.id, false, reason));
  }),
);

adminRouter.post(
  '/users/:id/enable',
  requireSuperAdmin,
  requirePermission('user:disable'),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    res.json(await setUserActive(actor, req.params.id, true));
  }),
);

adminRouter.post(
  '/users/:id/reset-password',
  requireSuperAdmin,
  requirePermission('user:reset-password'),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    // The generated password is in this response and nowhere else — it is
    // stored only as an argon2 hash. If the administrator loses it, the fix is
    // another reset, not a lookup.
    res.json(await resetPassword(actor, req.params.id));
  }),
);

adminRouter.post(
  '/users/:id/unlock',
  requireSuperAdmin,
  requirePermission('user:reset-password'),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    res.json(await unlockUser(actor, req.params.id));
  }),
);

const roleSchema = z.object({ roleKey: z.string().min(1) });

adminRouter.post(
  '/users/:id/role',
  requireSuperAdmin,
  requirePermission('role:assign'),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    const { roleKey } = roleSchema.parse(req.body);
    res.json(await changeRole(actor, req.params.id, roleKey));
  }),
);

const superAdminSchema = z.object({ isSuperAdmin: z.boolean() });

adminRouter.post(
  '/users/:id/super-admin',
  requireSuperAdmin,
  requirePermission('role:assign'),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    const { isSuperAdmin } = superAdminSchema.parse(req.body);
    res.json(await setSuperAdmin(actor, req.params.id, isSuperAdmin));
  }),
);

// ── Roles & configuration ───────────────────────────────────────────────────

adminRouter.get('/roles', requirePermission('user:manage'), asyncHandler(async (_req, res) => {
  res.json({ data: await listRoles() });
}));

/**
 * What the deployment is configured to allow. Read-only by design: the
 * allowlist is an environment setting precisely so that changing it takes a
 * deliberate act outside the application.
 */
adminRouter.get('/super-admin-allowlist', requirePermission('user:manage'), asyncHandler(async (_req, res) => {
  const holders = await prisma.user.findMany({
    where: { isSuperAdmin: true },
    select: { email: true, name: true, active: true },
  });
  res.json({
    allowlist: SUPER_ADMIN_EMAILS,
    holders: holders.map((h) => ({
      ...h,
      // An address that was removed from the environment but still carries the
      // flag: worth showing, because it explains a surprising 403.
      effective: SUPER_ADMIN_EMAILS.includes(h.email.toLowerCase()),
    })),
  });
}));

// ── Audit log ───────────────────────────────────────────────────────────────

/**
 * A date the user typed or a picker cleared.
 *
 * Without this, `new Date('last-week')` reaches Prisma as an Invalid Date and
 * comes back as a 500 with a stack trace — a mistyped filter should be a
 * message, not a server error.
 */
const dateFilter = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined))
  .refine((v) => v === undefined || !Number.isNaN(new Date(v).getTime()), {
    message: 'Enter a valid date (YYYY-MM-DD).',
  });

const auditQuery = z.object({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actorId: z.string().optional(),
  action: z.string().optional(),
  orderId: z.string().optional(),
  field: z.string().optional(),
  from: dateFilter,
  to: dateFilter,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

adminRouter.get('/audit', requirePermission('audit:read'), asyncHandler(async (req, res) => {
  const q = auditQuery.parse(req.query);

  const where = {
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.orderId ? { orderId: q.orderId } : {}),
    ...(q.field ? { field: { contains: q.field, mode: 'insensitive' as const } } : {}),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lte: endOfDay(q.to) } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.auditTrail.count({ where }),
    prisma.auditTrail.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { order: { select: { poNumber: true } } },
    }),
  ]);

  res.json({
    data: rows.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      action: r.action,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      actorId: r.actorId,
      actorName: r.actorName,
      reason: r.reason,
      orderId: r.orderId,
      orderPoNumber: r.order?.poNumber ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  });
}));

/**
 * The human-readable half of the record: sign-ins, account changes, production
 * entries — the sentences, where `/audit` holds the field diffs.
 */
const activityQuery = z.object({
  action: z.string().optional(),
  actorId: z.string().optional(),
  orderId: z.string().optional(),
  from: dateFilter,
  to: dateFilter,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

adminRouter.get('/activity', requirePermission('audit:read'), asyncHandler(async (req, res) => {
  const q = activityQuery.parse(req.query);

  const where = {
    ...(q.action ? { action: q.action } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.orderId ? { orderId: q.orderId } : {}),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lte: endOfDay(q.to) } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { order: { select: { poNumber: true } } },
    }),
  ]);

  res.json({
    data: rows.map((r) => ({
      id: r.id,
      action: r.action,
      summary: r.summary,
      actorId: r.actorId,
      actorName: r.actorName,
      entityType: r.entityType,
      entityId: r.entityId,
      orderId: r.orderId,
      orderPoNumber: r.order?.poNumber ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  });
}));

/** The distinct values present, so the filters offer only what exists. */
adminRouter.get('/audit/facets', requirePermission('audit:read'), asyncHandler(async (_req, res) => {
  const [entityTypes, auditActions, activityActions, actors] = await Promise.all([
    prisma.auditTrail.findMany({ distinct: ['entityType'], select: { entityType: true }, take: 100 }),
    prisma.auditTrail.findMany({ distinct: ['action'], select: { action: true }, take: 100 }),
    prisma.activityLog.findMany({ distinct: ['action'], select: { action: true }, take: 200 }),
    prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);

  res.json({
    entityTypes: entityTypes.map((e) => e.entityType).sort(),
    auditActions: auditActions.map((a) => a.action).sort(),
    activityActions: activityActions.map((a) => a.action).sort(),
    actors,
  });
}));

adminRouter.get('/audit/:entityType/:entityId', requirePermission('audit:read'), asyncHandler(async (req, res) => {
  // No rows is a valid answer — a record created a minute ago has no history
  // yet. Returning 404 here would make an empty history look like a broken URL.
  const rows = await prisma.auditTrail.findMany({
    where: { entityType: req.params.entityType, entityId: req.params.entityId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ data: rows });
}));

/**
 * Inclusive end of the selected day, so a "to" filter of today includes today.
 *
 * A bare `YYYY-MM-DD` parses as UTC midnight, so the end of it is computed in
 * UTC too. Using `setHours` here would apply the *server's* offset and silently
 * drop the last hours of the day the user asked for.
 */
function endOfDay(value: string): Date {
  const d = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    d.setUTCHours(23, 59, 59, 999);
    return d;
  }
  // A full timestamp was supplied — take it at face value.
  return d;
}
