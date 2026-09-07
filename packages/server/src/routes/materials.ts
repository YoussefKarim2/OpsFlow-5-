import { Router } from 'express';
import { z } from 'zod';
import { computeBomSummary, groupBomByCategory, computeMarkerPlan, computeFabricPosition, type BomItemInput, type LayInput } from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { refreshOrderCache, ORDER_INCLUDE, deriveOrder } from '../services/order-service.js';
import { logActivity, logAndNotify } from '../services/activity-service.js';

export const materialsRouter = Router();
materialsRouter.use(authenticate);

const dec = (v: { toString(): string } | null | undefined): number | null =>
  v == null ? null : Number(v.toString());

const CATEGORIES = [
  'FABRIC', 'THREAD', 'LABEL', 'TRANSFER', 'BADGE', 'LOGO', 'SPONSOR', 'SIZE',
  'POLY_BAG', 'BUTTER_PAPER', 'STICKY_TAPE', 'BARCODE_PAPER', 'HALF_BOX',
  'CARTON', 'TAPE', 'ACCESSORY', 'OTHER',
] as const;

// ── BOM ─────────────────────────────────────────────────────────────────────

materialsRouter.get('/:orderId/bom', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const items = await prisma.bomItem.findMany({
    where: { orderId: order.id },
    include: {
      color: true,
      sizes: { orderBy: { position: 'asc' } },
      issues: { include: { issuedBy: true, issuedTo: true }, orderBy: { issuedAt: 'desc' } },
    },
    orderBy: [{ category: 'asc' }, { position_: 'asc' }],
  });

  const inputs: BomItemInput[] = items.map((b) => ({
    id: b.id, category: b.category, position: b.position, item: b.item,
    description: b.description, color: b.color?.name ?? b.colorText ?? null,
    unit: b.unit, consumptionPerPiece: dec(b.consumptionPerPiece),
    requiredQty: Number(b.requiredQty.toString()), issuedQty: Number(b.issuedQty.toString()),
  }));

  const summary = computeBomSummary(inputs);

  res.json({
    summary,
    groups: groupBomByCategory(summary.items),
    items: summary.items.map((s) => {
      const row = items.find((i) => i.id === s.id)!;
      return {
        ...s,
        issuedByName: row.issuedByName,
        issuedToName: row.issuedToName,
        issuedAt: row.issuedAt?.toISOString() ?? null,
        purchaseOrderRef: row.purchaseOrderRef,
        unitPriceUsd: dec(row.unitPriceUsd),
        supplier: row.supplier,
        colorId: row.colorId,
        colorText: row.colorText,
        sizes: row.sizes.map((sz) => ({
          id: sz.id, sizeLabel: sz.sizeLabel, qty: Number(sz.qty.toString()),
        })),
        notes: row.notes,
        issues: row.issues.map((iss) => ({
          id: iss.id, qty: Number(iss.qty.toString()), unit: iss.unit,
          issuedAt: iss.issuedAt.toISOString(),
          issuedByName: iss.issuedBy?.name ?? null,
          issuedToName: iss.issuedTo?.name ?? iss.issuedToName ?? null,
          notes: iss.notes,
        })),
      };
    }),
  });
}));

const bomItemSchema = z.object({
  category: z.enum(CATEGORIES),
  position: z.string().optional(),
  item: z.string().min(1),
  description: z.string().optional(),
  colorId: z.string().optional(),
  colorText: z.string().optional(),
  consumptionPerPiece: z.number().nonnegative().optional(),
  requiredQty: z.number().nonnegative(),
  unit: z.string().min(1),
  unitPriceUsd: z.number().nonnegative().optional(),
  supplier: z.string().optional(),
  notes: z.string().optional(),
});

/** One size of one item: "Logo Badge / Medium / 150". */
const bomSizeSchema = z.object({
  sizeLabel: z.string().min(1, 'Every size row needs a size.'),
  qty: z.number().nonnegative(),
});

/**
 * A whole BOM row, as the table editor sends it.
 *
 * `id` present means an existing row, absent means a new one. Sending the whole
 * table rather than a row at a time is the Proforma Invoice's pattern and is
 * kept deliberately: a coordinator adds three items and edits a fourth before
 * pressing Save once, and four separate requests would leave the BOM in a state
 * nobody asked for if the third failed.
 */
const bomRowSchema = bomItemSchema.extend({
  id: z.string().optional(),
  sizes: z.array(bomSizeSchema).default([]),
});

/**
 * Replace the whole bill of materials for one order.
 *
 * Additive to the per-row POST/PATCH/DELETE below, which the import committer
 * and the issue flow still use. This is the manual editor's door: it diffs what
 * was sent against what is stored, so a row nobody touched keeps its id — and
 * with it its issues, movements and reservations, which are keyed on that id and
 * would be orphaned by a delete-and-recreate.
 *
 * `requiredQty` is recomputed as the sum of the size rows whenever any exist.
 * The shortage arithmetic in calc/materials.ts reads that one number, so the
 * breakdown has to roll up into it rather than sit beside it — otherwise a badge
 * needed in three sizes would be counted once, or three times, depending on
 * which field the reader trusted.
 */
materialsRouter.put('/:orderId/bom', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const rows = z.array(bomRowSchema).parse(req.body.items);

  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const existing = await prisma.bomItem.findMany({
    where: { orderId: order.id }, select: { id: true },
  });
  const keep = new Set(rows.map((r) => r.id).filter((id): id is string => !!id));
  const removed = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);

  await prisma.$transaction(async (tx) => {
    // Deleting first frees any unique constraint the rewritten rows might want.
    if (removed.length > 0) await tx.bomItem.deleteMany({ where: { id: { in: removed } } });

    for (const [i, row] of rows.entries()) {
      const { id, sizes, ...fields } = row;
      const total = sizes.length > 0
        ? sizes.reduce((a, s) => a + s.qty, 0)
        : fields.requiredQty;
      const data = { ...fields, requiredQty: total, position_: i };

      const itemId = id
        ? (await tx.bomItem.update({ where: { id }, data, select: { id: true } })).id
        : (await tx.bomItem.create({ data: { ...data, orderId: order.id }, select: { id: true } })).id;

      // The breakdown is small and wholly owned by its item, so replacing it is
      // simpler than diffing and nothing else references these rows.
      await tx.bomItemSize.deleteMany({ where: { bomItemId: itemId } });
      if (sizes.length > 0) {
        await tx.bomItemSize.createMany({
          data: sizes.map((sz, n) => ({ bomItemId: itemId, sizeLabel: sz.sizeLabel, qty: sz.qty, position: n })),
        });
      }
    }
  });

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'BOM_SAVED',
    summary: `saved the bill of materials — ${rows.length} item${rows.length === 1 ? '' : 's'}` +
             (removed.length > 0 ? `, ${removed.length} removed` : ''),
    entityType: 'Order', entityId: order.id,
  });

  await refreshOrderCache(order.id);
  res.json({ ok: true, count: rows.length, removed: removed.length });
}));

materialsRouter.post('/:orderId/bom', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = bomItemSchema.parse(req.body);

  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) throw new NotFoundError('Order');

  const count = await prisma.bomItem.count({ where: { orderId: order.id } });
  const item = await prisma.bomItem.create({
    data: { ...input, orderId: order.id, position_: count },
  });

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'BOM_ITEM_ADDED',
    summary: `added ${input.item} to the bill of materials — ${input.requiredQty.toLocaleString()} ${input.unit} required`,
    entityType: 'BomItem', entityId: item.id,
  });

  await refreshOrderCache(order.id);
  res.status(201).json({ id: item.id });
}));

materialsRouter.patch('/bom/:id', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = bomItemSchema.partial().parse(req.body);

  const item = await prisma.bomItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw new NotFoundError('BOM item');

  await prisma.bomItem.update({ where: { id: item.id }, data: input });
  await logActivity({
    orderId: item.orderId, actorId: actor.id, actorName: actor.name,
    action: 'BOM_ITEM_UPDATED', summary: `updated ${item.item} in the bill of materials`,
    entityType: 'BomItem', entityId: item.id,
  });

  await refreshOrderCache(item.orderId);
  res.json({ ok: true });
}));

materialsRouter.delete('/bom/:id', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const item = await prisma.bomItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw new NotFoundError('BOM item');
  await prisma.bomItem.delete({ where: { id: item.id } });
  await refreshOrderCache(item.orderId);
  res.status(204).end();
}));

// ── Issue materials — the warehouse's step ──────────────────────────────────

const issueSchema = z.object({
  qty: z.number().positive(),
  issuedToId: z.string().optional(),
  issuedToName: z.string().optional(),
  notes: z.string().optional(),
});

materialsRouter.post('/bom/:id/issue', requirePermission('material:issue'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = issueSchema.parse(req.body);

  const item = await prisma.bomItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw new NotFoundError('BOM item');

  const required = Number(item.requiredQty.toString());
  const alreadyIssued = Number(item.issuedQty.toString());
  const newTotal = alreadyIssued + input.qty;

  // Over-issue is allowed (waste happens) but not by an implausible multiple.
  if (required > 0 && newTotal > required * 2) {
    throw new ValidationError(
      `Issuing ${input.qty.toLocaleString()} would bring the total to ${newTotal.toLocaleString()} ${item.unit} ` +
        `against a requirement of ${required.toLocaleString()}. Check the figure.`,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const issue = await tx.materialIssue.create({
      data: {
        orderId: item.orderId, bomItemId: item.id, qty: input.qty, unit: item.unit,
        issuedById: actor.id, issuedToId: input.issuedToId, issuedToName: input.issuedToName,
        notes: input.notes,
      },
    });
    await tx.bomItem.update({
      where: { id: item.id },
      data: {
        issuedQty: newTotal,
        issuedByName: actor.name,
        issuedToName: input.issuedToName ?? item.issuedToName,
        issuedAt: new Date(),
      },
    });
    return issue;
  });

  await logActivity({
    orderId: item.orderId, actorId: actor.id, actorName: actor.name,
    action: 'MATERIAL_ISSUED',
    summary: `issued ${input.qty.toLocaleString()} ${item.unit} of ${item.item}${input.issuedToName ? ` to ${input.issuedToName}` : ''}`,
    entityType: 'MaterialIssue', entityId: result.id,
    meta: { item: item.item, qty: input.qty, unit: item.unit, newTotal, required },
  });

  // Once the last shortage clears, say so — it is what unblocks production.
  const remaining = await prisma.bomItem.findMany({
    where: { orderId: item.orderId },
    select: { requiredQty: true, issuedQty: true },
  });
  const stillShort = remaining.filter((b) => Number(b.issuedQty) < Number(b.requiredQty)).length;
  if (stillShort === 0) {
    await logAndNotify(
      {
        orderId: item.orderId, actorId: actor.id, actorName: 'System',
        action: 'MATERIALS_COMPLETE', summary: 'all materials have been issued — the order is ready for production',
      },
      {
        type: 'MATERIAL_SHORTAGE',
        title: 'All materials issued',
        body: 'Every bill-of-materials line is now covered. Production can start.',
        link: `/orders/${item.orderId}?tab=bom`,
        departments: ['PRODUCTION_MANAGER', 'FACTORY_MANAGER'],
      },
    );
  }

  await refreshOrderCache(item.orderId);
  res.status(201).json({ id: result.id, newIssuedQty: newTotal, stillShort });
}));

// ── Markers and fabric ──────────────────────────────────────────────────────

materialsRouter.get('/:orderId/markers', requirePermission('cutting:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    include: ORDER_INCLUDE,
  });
  if (!order) throw new NotFoundError('Order');

  const lays: LayInput[] = order.markers.map((m) => ({
    id: m.id, fabric: m.fabricName, color: m.fabricColor ?? '', panel: m.panel,
    ratio: m.sizeRatio, layers: m.layers,
    markerLengthM: Number(m.markerLengthM.toString()),
    nestPcs: m.nestPcs, efficiencyPct: dec(m.efficiencyPct),
  }));

  // Cut requirement per size name — what the lay plan must produce.
  const d = deriveOrder(order);
  const requiredBySize: Record<string, number> = {};
  for (const s of d.sizes) {
    requiredBySize[s.name] = d.cells
      .filter((c) => c.sizeId === s.id && c.ledger === 'CUT')
      .reduce((a, c) => a + c.qty, 0);
  }

  res.json({
    plan: computeMarkerPlan(lays, requiredBySize),
    fabrics: order.fabricRecords.map((f) =>
      computeFabricPosition({
        fabric: f.fabricName, color: f.colorName ?? '',
        requiredM: Number(f.requiredM?.toString() ?? 0),
        availableM: dec(f.availableM), issuedM: dec(f.issuedM),
        actualConsumptionM: dec(f.actualConsumptionM),
      }),
    ),
    cutting: order.cuttingRecords.map((c) => ({
      id: c.id, cutDate: c.cutDate?.toISOString() ?? null, cuttingTeam: c.cuttingTeam,
      cutByName: c.cutByName, inspectedByName: c.inspectedByName,
      actualCutQty: c.actualCutQty, fabricUsedM: dec(c.fabricUsedM), notes: c.notes,
    })),
  });
}));

const markerSchema = z.object({
  markerNumber: z.string().optional(),
  fabricName: z.string().min(1),
  fabricColor: z.string().optional(),
  panel: z.string().default('ALL'),
  sizeRatio: z.string().min(1),
  layers: z.number().int().positive(),
  markerLengthM: z.number().positive(),
  nestPcs: z.number().int().positive().optional(),
  efficiencyPct: z.number().optional(),
  notes: z.string().optional(),
});

materialsRouter.post('/:orderId/markers', requirePermission('cutting:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = markerSchema.parse(req.body);

  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) throw new NotFoundError('Order');

  const count = await prisma.marker.count({ where: { orderId: order.id } });
  const marker = await prisma.marker.create({ data: { ...input, orderId: order.id, position: count } });

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'MARKER_ADDED',
    summary: `added a lay: ${input.sizeRatio} × ${input.layers} layers at ${input.markerLengthM} m`,
    entityType: 'Marker', entityId: marker.id,
  });

  await refreshOrderCache(order.id);
  res.status(201).json({ id: marker.id });
}));

materialsRouter.delete('/markers/:id', requirePermission('cutting:write'), asyncHandler(async (req, res) => {
  const marker = await prisma.marker.findUnique({ where: { id: req.params.id } });
  if (!marker) throw new NotFoundError('Marker');
  await prisma.marker.delete({ where: { id: marker.id } });
  res.status(204).end();
}));

const cuttingSchema = z.object({
  cutDate: z.string().optional(),
  cuttingTeam: z.string().optional(),
  cutByName: z.string().optional(),
  inspectedByName: z.string().optional(),
  numberingByName: z.string().optional(),
  bundledByName: z.string().optional(),
  actualCutQty: z.number().int().nonnegative().optional(),
  fabricUsedM: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

materialsRouter.post('/:orderId/cutting', requirePermission('cutting:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = cuttingSchema.parse(req.body);

  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) throw new NotFoundError('Order');

  const record = await prisma.cuttingRecord.create({
    data: { ...input, orderId: order.id, cutDate: input.cutDate ? new Date(input.cutDate) : new Date() },
  });

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'CUTTING_RECORDED',
    summary: `recorded cutting${input.actualCutQty ? ` — ${input.actualCutQty.toLocaleString()} pcs` : ''}`,
    entityType: 'CuttingRecord', entityId: record.id,
  });

  await refreshOrderCache(order.id);
  res.status(201).json({ id: record.id });
}));
