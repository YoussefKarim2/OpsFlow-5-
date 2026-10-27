/**
 * Inventory routes.
 *
 * Thin by design: every one of these delegates to `inventory-service.ts`, which
 * owns the transactions and the rules. Nothing here computes a balance, and no
 * route writes `physicalQty` — stock only ever moves through a movement.
 *
 * Permissions reuse the existing material scopes rather than inventing a
 * parallel set: `material:read` to look, `material:issue` to move stock,
 * `material:edit` to change the catalogue.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  MaterialType, MovementType, StockStatus, UnitOfMeasure,
  MATERIAL_TYPE_LABEL, MATERIAL_TYPE_FIELDS, MOVEMENT_TYPE_LABEL,
  unitsCompatible,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import {
  listMaterials, getMaterial, getMovements, receiveStock, adjustStock, recordWastage,
  reserveForOrder, releaseReservation, decideReservation, issueToProduction, returnFromProduction,
  getOrderMaterialPosition, reserveOrderMaterials, reconcileStock,
} from '../services/inventory-service.js';
import { logActivity } from '../services/activity-service.js';
import { canDecideReservations } from '../config.js';

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);

const MATERIAL_TYPES = Object.keys(MATERIAL_TYPE_LABEL) as [MaterialType, ...MaterialType[]];
const UNITS = Object.keys(UnitOfMeasure) as [UnitOfMeasure, ...UnitOfMeasure[]];

// ── Reference ───────────────────────────────────────────────────────────────

/** Everything the material forms need to render, in one call. */
inventoryRouter.get('/meta', asyncHandler(async (_req, res) => {
  const locations = await prisma.inventoryLocation.findMany({
    where: { active: true }, orderBy: { name: 'asc' },
  });
  res.json({
    types: MATERIAL_TYPES.map((t) => ({
      value: t,
      label: MATERIAL_TYPE_LABEL[t],
      // Which optional fields this type actually uses, so the form does not ask
      // a carton for its fabric composition.
      fields: MATERIAL_TYPE_FIELDS[t],
    })),
    units: UNITS,
    movementTypes: Object.entries(MOVEMENT_TYPE_LABEL).map(([value, label]) => ({ value, label })),
    statuses: Object.keys(StockStatus),
    locations: locations.map((l) => ({ id: l.id, name: l.name, code: l.code, kind: l.kind })),
  });
}));

// ── Catalogue ───────────────────────────────────────────────────────────────

inventoryRouter.get('/materials', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const q = z.object({
    q: z.string().optional(),
    type: z.enum(MATERIAL_TYPES).optional(),
    status: z.enum(Object.keys(StockStatus) as [string, ...string[]]).optional(),
    lowOnly: z.coerce.boolean().optional(),
    includeInactive: z.coerce.boolean().optional(),
  }).parse(req.query);

  res.json(await listMaterials({
    q: q.q,
    type: q.type,
    status: q.status as StockStatus | undefined,
    lowOnly: q.lowOnly,
    activeOnly: !q.includeInactive,
  }));
}));

inventoryRouter.get('/materials/:id', requirePermission('material:read'), asyncHandler(async (req, res) => {
  res.json(await getMaterial(req.params.id));
}));

inventoryRouter.get('/materials/:id/movements', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit ?? 100);
  res.json({ data: await getMovements(req.params.id, limit) });
}));

const materialSchema = z.object({
  code: z.string().trim().max(64).optional().or(z.literal('')),
  name: z.string().trim().min(2, 'Give the material a name.'),
  type: z.enum(MATERIAL_TYPES),
  unit: z.enum(UNITS),
  description: z.string().optional(),
  colorName: z.string().optional(),
  widthCm: z.number().positive().optional(),
  composition: z.string().optional(),
  gsm: z.number().int().positive().optional(),
  sizeLabel: z.string().optional(),
  supplierName: z.string().optional(),
  supplierRef: z.string().optional(),
  minimumQty: z.number().min(0).optional(),
  unitCostUsd: z.number().min(0).optional(),
  notes: z.string().optional(),
});

inventoryRouter.post('/materials', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = materialSchema.parse(req.body);

  if (input.code) {
    const clash = await prisma.material.findUnique({ where: { code: input.code } });
    if (clash) throw new ValidationError(`The code "${input.code}" is already used by ${clash.name}.`);
  }

  const material = await prisma.material.create({
    data: { ...input, code: input.code || null },
  });

  await logActivity({
    actorId: actor.id, actorName: actor.name, action: 'MATERIAL_CREATED',
    summary: `added ${material.name} to the materials catalogue`,
    entityType: 'Material', entityId: material.id,
    meta: { type: material.type, unit: material.unit },
  });

  res.status(201).json(await getMaterial(material.id));
}));

inventoryRouter.patch('/materials/:id', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = materialSchema.partial().extend({ active: z.boolean().optional() }).parse(req.body);

  const existing = await prisma.material.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new NotFoundError('Material');

  // Changing the unit of a material that already has stock would silently
  // reinterpret every number recorded against it.
  if (input.unit && input.unit !== existing.unit) {
    const movements = await prisma.materialMovement.count({ where: { materialId: existing.id } });
    if (movements > 0) {
      throw new ValidationError(
        `${existing.name} already has ${movements} recorded movement${movements === 1 ? '' : 's'} in ${existing.unit}. ` +
        `Changing the unit now would reinterpret all of them. Create a new material instead.`,
      );
    }
  }

  await prisma.material.update({
    where: { id: req.params.id },
    data: { ...input, code: input.code === '' ? null : input.code },
  });

  await logActivity({
    actorId: actor.id, actorName: actor.name, action: 'MATERIAL_UPDATED',
    summary: `updated the material ${existing.name}`,
    entityType: 'Material', entityId: existing.id,
  });

  res.json(await getMaterial(req.params.id));
}));

/**
 * Why a material cannot be deleted, or null when it can.
 *
 * Deleting removes the row and everything that cascades from it, so a material
 * with any stock history — movements, stock on hand, reservations, or bill of
 * materials lines pointing at it — is refused: that history is the record of
 * what the factory bought, held and used. Mark it inactive instead.
 */
export function materialDeletionBlocker(c: {
  name: string; movements: number; reservations: number; bomLines: number; onHand: number;
}): string | null {
  const reasons: string[] = [];
  if (c.movements > 0) reasons.push(`${c.movements} stock movement${c.movements === 1 ? '' : 's'}`);
  if (c.onHand > 0) reasons.push('stock on hand');
  if (c.reservations > 0) reasons.push(`${c.reservations} reservation${c.reservations === 1 ? '' : 's'}`);
  if (c.bomLines > 0) reasons.push(`${c.bomLines} bill-of-materials line${c.bomLines === 1 ? '' : 's'}`);
  return reasons.length === 0 ? null
    : `${c.name} has ${reasons.join(', ')}, so deleting it would erase that history. Mark it inactive instead.`;
}

// Super administrators only: deleting is permanent, and the catalogue is shared
// by every order.
inventoryRouter.delete('/materials/:id', asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  if (!actor.isSuperAdmin) throw new ForbiddenError('Only a super administrator can delete materials.');
  const material = await prisma.material.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { movements: true, reservations: true, bomItems: true } },
      stock: { select: { physicalQty: true } },
    },
  });
  if (!material) throw new NotFoundError('Material');
  const blocker = materialDeletionBlocker({
    name: material.name,
    movements: material._count.movements,
    reservations: material._count.reservations,
    bomLines: material._count.bomItems,
    onHand: material.stock.reduce((a, s) => a + Number(s.physicalQty.toString()), 0),
  });
  if (blocker) throw new ConflictError(blocker);

  await prisma.material.delete({ where: { id: material.id } });
  await logActivity({
    actorId: actor.id, actorName: actor.name, action: 'MATERIAL_DELETED',
    summary: `deleted the material ${material.name} from the catalogue`,
    entityType: 'Material', entityId: material.id,
    meta: { code: material.code, type: material.type, unit: material.unit },
  });
  res.status(204).end();
}));

// ── Stock movements ─────────────────────────────────────────────────────────

const receiveSchema = z.object({
  materialId: z.string().min(1),
  qty: z.number().positive('Enter a quantity greater than zero.'),
  unit: z.string().optional(),
  locationId: z.string().nullable().optional(),
  batchLot: z.string().optional(),
  reference: z.string().optional(),
  reason: z.string().optional(),
  unitCostUsd: z.number().min(0).nullable().optional(),
});

inventoryRouter.post('/receipts', requirePermission('material:issue'), asyncHandler(async (req, res) => {
  res.status(201).json(await receiveStock(currentUser(req), receiveSchema.parse(req.body)));
}));

const adjustSchema = z.object({
  materialId: z.string().min(1),
  /** Signed: negative when a count found less than the book figure. */
  qty: z.number().refine((n) => n !== 0, 'An adjustment of zero changes nothing.'),
  locationId: z.string().nullable().optional(),
  reason: z.string().trim().min(3, 'Say what was counted and why it differs.'),
});

inventoryRouter.post('/adjustments', requirePermission('material:issue'), asyncHandler(async (req, res) => {
  res.status(201).json(await adjustStock(currentUser(req), adjustSchema.parse(req.body)));
}));

const wastageSchema = z.object({
  materialId: z.string().min(1),
  qty: z.number().positive(),
  orderId: z.string().nullable().optional(),
  /** The order's BOM line the waste belongs to, so its own reservation carries it. */
  bomItemId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
  reason: z.string().trim().min(3, 'Say what was wasted and why.'),
});

inventoryRouter.post('/wastage', requirePermission('material:issue'), asyncHandler(async (req, res) => {
  res.status(201).json(await recordWastage(currentUser(req), wastageSchema.parse(req.body)));
}));

// ── Reservations ────────────────────────────────────────────────────────────

const reserveSchema = z.object({
  materialId: z.string().min(1),
  orderId: z.string().min(1),
  qty: z.number().positive(),
  unit: z.string().optional(),
  bomItemId: z.string().nullable().optional(),
  notes: z.string().optional(),
  allowPartial: z.boolean().optional(),
});

// Anyone who can see materials may ask for a reservation. Unless they decide
// reservations themselves, it is a request that holds no stock until accepted.
inventoryRouter.post('/reservations', requirePermission('material:read'), asyncHandler(async (req, res) => {
  res.status(201).json(await reserveForOrder(currentUser(req), reserveSchema.parse(req.body)));
}));

// Releasing held stock needs material:edit; withdrawing one's own request does
// not. The service decides which applies.
inventoryRouter.post('/reservations/:id/release', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
  res.json(await releaseReservation(currentUser(req), req.params.id, reason));
}));

const decisionSchema = z.object({ note: z.string().max(500).optional() });

inventoryRouter.post('/reservations/:id/accept', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const { note } = decisionSchema.parse(req.body ?? {});
  res.json(await decideReservation(currentUser(req), req.params.id, true, note));
}));

inventoryRouter.post('/reservations/:id/reject', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const { note } = decisionSchema.parse(req.body ?? {});
  res.json(await decideReservation(currentUser(req), req.params.id, false, note));
}));

inventoryRouter.get('/reservations', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const q = z.object({
    orderId: z.string().optional(),
    materialId: z.string().optional(),
    status: z.string().optional(),
  }).parse(req.query);

  const reservations = await prisma.materialReservation.findMany({
    where: {
      ...(q.orderId ? { orderId: q.orderId } : {}),
      ...(q.materialId ? { materialId: q.materialId } : {}),
      status: (q.status as never) ?? 'ACTIVE',
    },
    include: {
      material: { select: { id: true, name: true, code: true, unit: true, type: true } },
      order: { select: { id: true, poNumber: true, orderName: true, requiredDeliveryDate: true } },
      reservedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });

  res.json({
    data: reservations.map((r) => ({
      id: r.id,
      materialId: r.materialId,
      materialName: r.material.name,
      materialCode: r.material.code,
      materialType: r.material.type,
      orderId: r.orderId,
      poNumber: r.order.poNumber,
      orderName: r.order.orderName,
      requiredDeliveryDate: r.order.requiredDeliveryDate?.toISOString() ?? null,
      qty: Number(r.qty.toString()),
      consumedQty: Number(r.consumedQty.toString()),
      outstandingQty: Math.max(0, Number(r.qty.toString()) - Number(r.consumedQty.toString())),
      unit: r.unit,
      status: r.status,
      reservedByName: r.reservedBy?.name ?? null,
      reservedById: r.reservedById,
      decidedByName: r.decidedBy?.name ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      createdAt: r.createdAt.toISOString(),
    })),
    // Whether the person asking may accept or reject what is waiting.
    canDecide: canDecideReservations(currentUser(req)),
  });
}));

// ── Issue and return ────────────────────────────────────────────────────────

const issueSchema = z.object({
  materialId: z.string().min(1),
  orderId: z.string().min(1),
  qty: z.number().positive(),
  unit: z.string().optional(),
  bomItemId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
  stage: z.string().nullable().optional(),
  reason: z.string().optional(),
  batchLot: z.string().optional(),
  issuedToName: z.string().optional(),
});

inventoryRouter.post('/issues', requirePermission('material:issue'), asyncHandler(async (req, res) => {
  res.status(201).json(await issueToProduction(currentUser(req), issueSchema.parse(req.body)));
}));

const returnSchema = z.object({
  materialId: z.string().min(1),
  orderId: z.string().min(1),
  qty: z.number().positive(),
  unit: z.string().optional(),
  bomItemId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
  reason: z.string().optional(),
});

inventoryRouter.post('/returns', requirePermission('material:issue'), asyncHandler(async (req, res) => {
  res.status(201).json(await returnFromProduction(currentUser(req), returnSchema.parse(req.body)));
}));

// ── Movement feed ───────────────────────────────────────────────────────────

inventoryRouter.get('/movements', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const q = z.object({
    materialId: z.string().optional(),
    orderId: z.string().optional(),
    type: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(req.query);

  const movements = await prisma.materialMovement.findMany({
    where: {
      ...(q.materialId ? { materialId: q.materialId } : {}),
      ...(q.orderId ? { orderId: q.orderId } : {}),
      ...(q.type ? { type: q.type as never } : {}),
    },
    include: {
      material: { select: { id: true, name: true, code: true, unit: true } },
      order: { select: { id: true, poNumber: true } },
    },
    orderBy: { occurredAt: 'desc' },
    take: q.limit,
  });

  res.json({
    data: movements.map((m) => {
      const qty = Number(m.qty.toString());
      const inbound = m.type === 'RECEIPT' || m.type === 'RETURN' || m.type === 'TRANSFER_IN';
      return {
        id: m.id,
        materialId: m.materialId,
        materialName: m.material.name,
        materialCode: m.material.code,
        type: m.type,
        qty,
        signedQty: m.type === 'ADJUSTMENT' ? qty : Math.abs(qty) * (inbound ? 1 : -1),
        unit: m.unit,
        balanceAfter: Number(m.balanceAfter.toString()),
        orderId: m.orderId,
        orderPoNumber: m.order?.poNumber ?? null,
        reason: m.reason,
        batchLot: m.batchLot,
        stage: m.stage,
        actorName: m.actorName,
        occurredAt: m.occurredAt.toISOString(),
      };
    }),
  });
}));

// ── Order material position ─────────────────────────────────────────────────

inventoryRouter.get('/orders/:orderId/position', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');
  res.json(await getOrderMaterialPosition(order.id));
}));

inventoryRouter.post('/orders/:orderId/reserve', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId }, select: { id: true } });
  if (!order) throw new NotFoundError('Order');
  res.json(await reserveOrderMaterials(currentUser(req), order.id));
}));

/** Link a BOM line to a catalogue material, so it can be checked against stock. */
inventoryRouter.post('/bom/:bomItemId/link', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const { materialId } = z.object({ materialId: z.string().nullable() }).parse(req.body);

  const bom = await prisma.bomItem.findUnique({ where: { id: req.params.bomItemId } });
  if (!bom) throw new NotFoundError('BOM line');

  if (materialId) {
    const material = await prisma.material.findUnique({ where: { id: materialId } });
    if (!material) throw new NotFoundError('Material');
    // Linking a line measured in metres to a material held in pieces would make
    // every subsequent comparison meaningless.
    if (!unitsCompatible(bom.unit, material.unit)) {
      throw new ValidationError(
        `This line is measured in ${bom.unit} and ${material.name} is held in ${material.unit}. ` +
        `Those cannot be compared, so the line cannot be linked to that material.`,
      );
    }
  }

  await prisma.bomItem.update({ where: { id: bom.id }, data: { materialId } });
  await logActivity({
    orderId: bom.orderId,
    actorId: actor.id, actorName: actor.name,
    action: materialId ? 'BOM_MATERIAL_LINKED' : 'BOM_MATERIAL_UNLINKED',
    summary: materialId
      ? `linked the BOM line "${bom.item}" to a catalogue material`
      : `unlinked the BOM line "${bom.item}" from its material`,
    entityType: 'BomItem', entityId: bom.id,
  });

  res.json(await getOrderMaterialPosition(bom.orderId));
}));

// ── Locations ───────────────────────────────────────────────────────────────

inventoryRouter.post('/locations', requirePermission('refdata:manage'), asyncHandler(async (req, res) => {
  const input = z.object({
    name: z.string().trim().min(2),
    code: z.string().optional(),
    kind: z.string().default('STORE'),
    notes: z.string().optional(),
  }).parse(req.body);
  const location = await prisma.inventoryLocation.create({ data: input });
  res.status(201).json(location);
}));

// ── Reconciliation ──────────────────────────────────────────────────────────

/**
 * Check every running balance against the movement ledger.
 *
 * `material:edit` to look, and the same to correct: this is the tool that
 * proves the running balance can be trusted, so it needs to be runnable by the
 * people who care, not buried in an admin corner.
 */
inventoryRouter.post('/reconcile', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const { fix } = z.object({ fix: z.boolean().default(false) }).parse(req.body ?? {});
  res.json(await reconcileStock(currentUser(req), { fix }));
}));
