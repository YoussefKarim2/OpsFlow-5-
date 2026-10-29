import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { computeBomSummary, groupBomByCategory, computeMarkerPlan, computeFabricPosition, parseSizeRatio, unitsCompatible, normaliseUnit, type BomItemInput, type CutSize, type LayInput } from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { refreshOrderCache, ORDER_INCLUDE, deriveOrder } from '../services/order-service.js';
import { logActivity, logAndNotify } from '../services/activity-service.js';
import { issueToProduction, returnFromProduction, assertIssueCorrectionsPossible } from '../services/inventory-service.js';
import { clearLayPlan } from '../services/import/laying-committer.js';
import { inWearingOrder, sizeAliasFor } from '../services/import/po-lines.js';
import type { AuthUser } from '../middleware/auth.js';

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

/**
 * The order's sizes with the cut order's pieces in each, smallest first.
 *
 * The bill of materials' per-size breakdown is filled from these: a size
 * label or a hang tag is needed per cut piece of each size.
 */
async function cutSizesOf(orderId: string): Promise<CutSize[]> {
  const sizes = await prisma.orderSize.findMany({
    where: { orderId },
    select: {
      id: true, position: true, size: { select: { name: true } },
      quantities: { where: { ledger: { in: ['CUT', 'ORDER'] } }, select: { ledger: true, qty: true } },
    },
  });
  return inWearingOrder(sizes.map((s) => ({ id: s.id, name: s.size.name, position: s.position, quantities: s.quantities })))
    .map((s) => ({
      name: s.name,
      cutQty: s.quantities.filter((q) => q.ledger === 'CUT').reduce((a, q) => a + q.qty, 0),
      orderQty: s.quantities.filter((q) => q.ledger === 'ORDER').reduce((a, q) => a + q.qty, 0),
    }));
}

materialsRouter.get('/:orderId/bom', requirePermission('material:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const [items, sizes] = await Promise.all([
    prisma.bomItem.findMany({
      where: { orderId: order.id },
      include: {
        color: true,
        sizes: { orderBy: { position: 'asc' } },
        issues: { include: { issuedBy: true, issuedTo: true }, orderBy: { issuedAt: 'desc' } },
      },
      // The order the lines were written in — the sheet's, or the editor's.
      // Sorted by category first, a line added at the bottom of the editor
      // reopened somewhere in the middle, and the save then renumbered every
      // line to the shuffled order.
      orderBy: [{ position_: 'asc' }, { createdAt: 'asc' }],
    }),
    cutSizesOf(order.id),
  ]);

  const inputs: BomItemInput[] = items.map((b) => ({
    id: b.id, category: b.category, position: b.position, item: b.item,
    description: b.description, color: b.color?.name ?? b.colorText ?? null,
    unit: b.unit, consumptionPerPiece: dec(b.consumptionPerPiece),
    requiredQty: Number(b.requiredQty.toString()), issuedQty: Number(b.issuedQty.toString()),
  }));

  const summary = computeBomSummary(inputs);

  res.json({
    summary,
    sizes,
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

/**
 * A bill-of-material line as the editor actually sends it.
 *
 * Every optional field here used to be `z.string().optional()`, which accepts
 * `undefined` and rejects `null` — and the screen sends `null`, because that is
 * what the GET returns for an empty description, colour, supplier or price and
 * the editor hands back the row it was given.
 *
 * So a BOM line with any empty field — which is nearly every line — failed
 * validation with 422, and the editor had no error handler, so the Save button
 * completed and nothing happened. Saving the bill of materials was broken for
 * anyone who did not fill in all nine columns.
 *
 * `nullable()` throughout, and the writes below turn null into "leave it
 * empty", which is what the user meant by leaving the box blank.
 */
const bomItemSchema = z.object({
  category: z.enum(CATEGORIES),
  position: z.string().nullish(),
  item: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  colorId: z.string().nullish(),
  colorText: z.string().max(200).nullish(),
  consumptionPerPiece: z.number().nonnegative().max(999_999.999999).nullish(),
  requiredQty: z.number().nonnegative().max(9_999_999_999),
  /**
   * What the warehouse has actually issued.
   *
   * Editable here as well as on the Materials tab. That tab's dialog only ever
   * *adds* — it is the warehouse recording a handover, with a recipient and a
   * note — so a figure typed once could not afterwards be corrected downwards
   * or at all. Correcting a number nobody can correct is not an edge case; it
   * is Tuesday.
   *
   * The correction is recorded rather than applied silently: the difference
   * lands in `material_issues` like any other movement, so the log still adds
   * up to the total and the costing, which reads issued quantities as actual
   * consumption, changes for a reason somebody can find.
   */
  issuedQty: z.number().nonnegative().max(99_999_999).nullish(),
  unit: z.string().min(1).max(40),
  unitPriceUsd: z.number().nonnegative().max(999_999.9999).nullish(),
  supplier: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
});

/** One size of one item: "Logo Badge / Medium / 150". */
const bomSizeSchema = z.object({
  sizeLabel: z.string().trim().min(1, 'Every size row needs a size.').max(60),
  qty: z.number().nonnegative().max(99_999_999),
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
  sizes: z.array(bomSizeSchema).max(200).default([]),
});

const saveBomSchema = z.object({
  items: z.array(bomRowSchema).max(2000),
  /**
   * Lines removed in the editor. Only these are deleted: a line the editor did
   * not send is left alone. "Stored minus sent" used to be the rule, so a line
   * somebody else added — or the import committed — after this editor opened
   * was deleted by a save from a screen that had never seen it. The lay plan's
   * PUT works the same way.
   */
  removeIds: z.array(z.string()).max(2000).default([]),
});

/** What a BOM line carries that makes removing it unsafe. */
export interface BomLineHistory {
  item: string;
  issuedQty: number;
  issueCount: number;
  /** Reservations still ACTIVE or PENDING against the line. */
  openReservations: number;
}

/**
 * Why these BOM lines cannot be removed, or null when they can.
 *
 * A line material has been issued against is history, not a draft. Deleting
 * it took its issue records with it (they cascade), the costing's actual
 * consumption dropped, and the stock movements were left pointing at nothing.
 *
 * A line holding a reservation or a request is a claim on the shelf. Deleting
 * it left the reservation tied to nothing — stock held for a line that no
 * longer exists, invisible on the order and still subtracted from what every
 * other order could take. It is released or withdrawn first, on purpose.
 */
export function bomRemovalBlocker(lines: readonly BomLineHistory[]): string | null {
  const issued = lines.filter((l) => l.issuedQty > 0 || l.issueCount > 0);
  if (issued.length > 0) {
    return `Material has already been issued against ${issued.map((l) => l.item).join(', ')}, so `
      + `${issued.length === 1 ? 'it' : 'they'} cannot be removed from the bill of materials. `
      + 'Reload the page if you did not mean to remove them.';
  }
  const held = lines.filter((l) => l.openReservations > 0);
  if (held.length > 0) {
    return `${held.map((l) => l.item).join(', ')} ${held.length === 1 ? 'has' : 'have'} stock reserved or requested, `
      + `so ${held.length === 1 ? 'it' : 'they'} cannot be removed from the bill of materials. `
      + 'Release the reservation or withdraw the request on the Materials tab first.';
  }
  return null;
}

/** The counts `bomRemovalBlocker` reads, selected alongside a BOM line. */
const BOM_HISTORY_COUNT = {
  _count: {
    select: {
      issues: true,
      reservations: { where: { status: { in: ['ACTIVE', 'PENDING'] as Array<'ACTIVE' | 'PENDING'> } } },
    },
  },
} as const;

function toHistory(l: {
  item: string; issuedQty: Prisma.Decimal; _count: { issues: number; reservations: number };
}): BomLineHistory {
  return {
    item: l.item, issuedQty: Number(l.issuedQty.toString()),
    issueCount: l._count.issues, openReservations: l._count.reservations,
  };
}

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
/** Whether two spellings mean one unit: "pcs", "Pcs" and "PCS" are the same column. */
const sameUnit = (a: string, b: string): boolean =>
  (normaliseUnit(a) ?? a.trim().toLowerCase()) === (normaliseUnit(b) ?? b.trim().toLowerCase());

/**
 * Refuse a unit change the line's history cannot follow.
 *
 * The unit a line is counted in is the unit its issues were recorded in.
 * Once anything has been issued, "100 Met." does not become "100 Cm." by
 * renaming the column; and a line drawn from stock must stay in a unit the
 * material can be converted to, or every later issue is refused.
 */
function assertUnitChange(
  before: { item: string; unit: string; issuedQty: Prisma.Decimal; _count: { issues: number }; material: { unit: string } | null },
  unit: string,
): void {
  if (sameUnit(unit, before.unit)) return;
  if (Number(before.issuedQty.toString()) > 0) {
    throw new ConflictError(`${before.item} has already been issued in ${before.unit}, so its unit cannot be changed to ${unit}. Correct the issued figure to 0 first, or add a new line.`);
  }
  if (before._count.issues > 0) {
    throw new ConflictError(`${before.item} has issue records in ${before.unit}, so its unit cannot be changed to ${unit}. Add a new line in ${unit} instead.`);
  }
  if (before.material && !unitsCompatible(unit, before.material.unit)) {
    throw new ValidationError(`${before.item} is drawn from stock held in ${before.material.unit}; ${unit} cannot be converted to it. Unlink the material on the Materials tab first.`);
  }
}

const ISSUE_PERMISSION_MESSAGE = 'Changing the issued figure requires the "material:issue" permission. Leave the Issued column as it was.';

/**
 * Set the issued quantity to a figure somebody typed, and record the change.
 *
 * The difference is written to `material_issues` — negative when the figure is
 * corrected downwards — so the log remains a running account that adds up to
 * the total on the item, and the costing, which reads issued quantities as
 * actual consumption, moves for a reason that can be traced.
 */
async function setIssuedQty(
  item: { id: string; orderId: string; unit: string; issuedQty: Prisma.Decimal; materialId: string | null },
  issued: number,
  actor: AuthUser,
): Promise<void> {
  const was = Number(item.issuedQty.toString());
  if (issued === was) return;
  const notes = `Corrected on the bill of materials from ${was.toLocaleString()} to ${issued.toLocaleString()}`;

  // A line linked to a catalogue material draws on real stock. Raising its
  // issued figure without moving the stock left the shelf, the reservation
  // and the movement ledger all saying the material was still there. So the
  // correction goes through the inventory service — an issue when it rises, a
  // return when it falls — and the three move together.
  if (item.materialId) {
    const delta = issued - was;
    const movement = {
      materialId: item.materialId, orderId: item.orderId, unit: item.unit, bomItemId: item.id, reason: notes,
      // The log row is written below with exactly the typed difference.
      recordBomIssue: false,
    };
    if (delta > 0) await issueToProduction(actor, { ...movement, qty: delta });
    else await returnFromProduction(actor, { ...movement, qty: -delta });
    await prisma.$transaction(async (tx) => {
      // The stock side converts through the material's unit and back; the
      // line keeps exactly the figure that was typed.
      await tx.bomItem.update({
        where: { id: item.id },
        data: { issuedQty: issued, issuedByName: actor.name, issuedAt: new Date() },
      });
      await tx.materialIssue.create({
        data: { orderId: item.orderId, bomItemId: item.id, qty: delta, unit: item.unit, issuedById: actor.id, notes },
      });
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.bomItem.update({
      where: { id: item.id },
      data: { issuedQty: issued, issuedByName: actor.name, issuedAt: new Date() },
    });
    await tx.materialIssue.create({
      data: {
        orderId: item.orderId, bomItemId: item.id, qty: issued - was,
        unit: item.unit, issuedById: actor.id,
        notes,
      },
    });
  });
}

materialsRouter.put('/:orderId/bom', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const { items: rows, removeIds } = saveBomSchema.parse(req.body ?? {});

  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const existing = await prisma.bomItem.findMany({
    where: { orderId: order.id },
    select: {
      id: true, item: true, issuedQty: true, unit: true, materialId: true,
      colorId: true, color: { select: { name: true } }, material: { select: { unit: true } },
      ...BOM_HISTORY_COUNT,
    },
  });
  const known = new Map(existing.map((e) => [e.id, e]));

  // A row's id is the client's word for which line it is. It has to be a line
  // of this order: an id from another order's BOM would otherwise have been
  // updated here, and moved to this order's position list besides.
  if (rows.some((r) => r.id && !known.has(r.id))) {
    throw new ValidationError('One of the lines is no longer on this bill of materials. Reload and try again.');
  }

  // An issued figure typed here is an issue — stock leaves the shelf and the
  // log gets a row — and issuing is the warehouse's permission, not the
  // editor's. A coordinator may write the whole bill and still not issue it.
  if (rows.some((r) => r.issuedQty != null) && !actor.permissions.includes('material:issue')) {
    throw new ForbiddenError(ISSUE_PERMISSION_MESSAGE);
  }

  for (const r of rows) {
    const before = r.id ? known.get(r.id) : undefined;
    if (before) assertUnitChange(before, r.unit);
  }
  const sent = new Set(rows.map((r) => r.id).filter((id): id is string => !!id));
  const removedRows = removeIds
    .filter((id, i) => removeIds.indexOf(id) === i && !sent.has(id))
    .map((id) => known.get(id))
    .filter((e): e is NonNullable<typeof e> => !!e);
  const removed = removedRows.map((e) => e.id);

  const blocked = bomRemovalBlocker(removedRows.map(toHistory));
  if (blocked) throw new ConflictError(blocked);

  // Issued figures on lines linked to stock: they move the shelf through the
  // inventory service, which keeps its own transactions, so they are applied
  // once the rows are saved — and checked now, before anything is written, so
  // a figure stock cannot honour refuses the whole save rather than half of it.
  const linkedIssues: Array<{ id: string; issued: number }> = [];
  const linkedChecks: Array<{ bomItemId: string; materialId: string; unit: string; was: number; issued: number }> = [];
  for (const r of rows) {
    const before = r.id ? known.get(r.id) : undefined;
    if (r.issuedQty == null || !before?.materialId) continue;
    linkedIssues.push({ id: before.id, issued: r.issuedQty });
    linkedChecks.push({
      bomItemId: before.id, materialId: before.materialId, unit: r.unit,
      was: Number(before.issuedQty.toString()), issued: r.issuedQty,
    });
  }
  await assertIssueCorrectionsPossible(order.id, linkedChecks);

  try {
    await prisma.$transaction(async (tx) => {
      // Deleting first frees any unique constraint the rewritten rows might want.
      // The blocker above read the lines before this transaction; an issue the
      // warehouse recorded in between would cascade away with its line, so the
      // delete itself refuses a line that has history by now.
      if (removed.length > 0) {
        const { count } = await tx.bomItem.deleteMany({
          where: {
            id: { in: removed },
            issues: { none: {} },
            reservations: { none: { status: { in: ['ACTIVE', 'PENDING'] } } },
          },
        });
        if (count !== removed.length) {
          throw new ConflictError('Material was issued or reserved against a removed line while this editor was open. Reload the page and try again.');
        }
      }

      for (const [i, row] of rows.entries()) {
        const { id, sizes, issuedQty, ...fields } = row;
        const total = sizes.length > 0
          ? sizes.reduce((a, s) => a + s.qty, 0)
          : fields.requiredQty;
        const before = id ? known.get(id) ?? null : null;

        // A line linked to a colour on the master list shows that colour's
        // name, whatever its text says. Retyping — or clearing — the colour
        // in the editor changed only the text, so the line went on showing
        // the old colour. A colour sent that is not the linked one drops the
        // link; a request that does not mention the colour leaves it.
        const typedColour = fields.colorText === undefined ? undefined : (fields.colorText ?? '').trim();
        const unlinkColour = before?.colorId != null && fields.colorId === undefined && typedColour !== undefined
          && typedColour.toLowerCase() !== (before.color?.name ?? '').trim().toLowerCase();
        const data = { ...fields, requiredQty: total, position_: i, ...(unlinkColour ? { colorId: null } : {}) };

        // The issued figure as it stands now, read inside the transaction:
        // what the editor loaded may be behind an issue the warehouse
        // recorded since, and the log row must carry the true difference.
        const issuedNow = id && issuedQty != null && !before?.materialId
          ? await tx.bomItem.findUniqueOrThrow({ where: { id }, select: { issuedQty: true } })
          : null;

        const itemId = id
          ? (await tx.bomItem.update({ where: { id }, data, select: { id: true } })).id
          : (await tx.bomItem.create({ data: { ...data, orderId: order.id }, select: { id: true } })).id;

        // A line linked to a catalogue material draws on real stock, so its
        // correction has to move the shelf and the reservation too. That was
        // gathered and checked above, and is applied once the rows are saved.
        if (issuedQty != null && !before?.materialId) {
          const was = issuedNow ? Number(issuedNow.issuedQty.toString()) : 0;
          const delta = issuedQty - was;
          if (delta !== 0) {
            await tx.bomItem.update({
              where: { id: itemId },
              data: { issuedQty, issuedByName: actor.name, issuedAt: new Date() },
            });
            // Negative when the figure is corrected downwards. The log is a
            // running account, so it has to be able to go both ways.
            await tx.materialIssue.create({
              data: {
                orderId: order.id, bomItemId: itemId, qty: delta,
                unit: fields.unit, issuedById: actor.id,
                notes: `Corrected on the bill of materials from ${was.toLocaleString()} to ${issuedQty.toLocaleString()}`,
              },
            });
          }
        }

        // The breakdown is small and wholly owned by its item, so replacing it is
        // simpler than diffing and nothing else references these rows.
        await tx.bomItemSize.deleteMany({ where: { bomItemId: itemId } });
        if (sizes.length > 0) {
          await tx.bomItemSize.createMany({
            data: sizes.map((sz, n) => ({ bomItemId: itemId, sizeLabel: sz.sizeLabel, qty: sz.qty, position: n })),
          });
        }
      }
    // A full bill is sixty lines, each written in three statements; the
    // default five seconds was not always enough from the factory's link.
    }, { timeout: 30_000 });

    for (const { id, issued } of linkedIssues) {
      const item = await prisma.bomItem.findUniqueOrThrow({
        where: { id },
        select: { id: true, orderId: true, unit: true, issuedQty: true, materialId: true },
      });
      await setIssuedQty(item, issued, actor);
    }

    await logActivity({
      orderId: order.id, actorId: actor.id, actorName: actor.name,
      action: 'BOM_SAVED',
      summary: `saved the bill of materials — ${rows.length} item${rows.length === 1 ? '' : 's'}` +
               (removed.length > 0 ? `, ${removed.length} removed` : ''),
      entityType: 'Order', entityId: order.id,
    });
  } finally {
    // Whatever was written — all of it, or the rows before a stock movement
    // that lost a race — the order's cached figures follow it.
    await refreshOrderCache(order.id);
  }

  res.json({ ok: true, count: rows.length, removed: removed.length });
}));

/**
 * `issuedQty` is not nullable in the database — it defaults to zero and a row
 * always has one. A form that sends it empty means "unchanged", never "null",
 * so it is lifted out of the data Prisma is handed and applied only when it
 * carries a number.
 */
function splitIssued<T extends { issuedQty?: number | null }>(
  input: T,
): { rest: Omit<T, 'issuedQty'>; issued: number | null } {
  const { issuedQty, ...rest } = input;
  return { rest, issued: typeof issuedQty === 'number' ? issuedQty : null };
}

materialsRouter.post('/:orderId/bom', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const parsed = bomItemSchema.parse(req.body);
  const { rest: input, issued } = splitIssued(parsed);
  if (issued != null && !actor.permissions.includes('material:issue')) throw new ForbiddenError(ISSUE_PERMISSION_MESSAGE);

  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) throw new NotFoundError('Order');

  const count = await prisma.bomItem.count({ where: { orderId: order.id } });
  const item = await prisma.bomItem.create({
    data: { ...input, orderId: order.id, position_: count, ...(issued == null ? {} : { issuedQty: issued }) },
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
  const parsed = bomItemSchema.partial().parse(req.body);
  const { rest: input, issued } = splitIssued(parsed);
  if (issued != null && !actor.permissions.includes('material:issue')) throw new ForbiddenError(ISSUE_PERMISSION_MESSAGE);

  const item = await prisma.bomItem.findUnique({
    where: { id: req.params.id },
    include: { material: { select: { unit: true } }, sizes: { select: { qty: true } }, ...BOM_HISTORY_COUNT },
  });
  if (!item) throw new NotFoundError('BOM item');
  // The same rules as the whole-table save: the unit follows the line's
  // history, and a line broken down by size is the sum of its sizes.
  if (input.unit !== undefined) assertUnitChange(item, input.unit);
  if (item.sizes.length > 0 && input.requiredQty !== undefined) {
    input.requiredQty = item.sizes.reduce((a, z) => a + Number(z.qty.toString()), 0);
  }

  // The row as it stands after this edit, so a correction to the issued
  // figure is read against the unit and material the line now has.
  const updated = await prisma.bomItem.update({ where: { id: item.id }, data: input });
  if (issued != null) await setIssuedQty(updated, issued, actor);
  await logActivity({
    orderId: item.orderId, actorId: actor.id, actorName: actor.name,
    action: 'BOM_ITEM_UPDATED', summary: `updated ${item.item} in the bill of materials`,
    entityType: 'BomItem', entityId: item.id,
  });

  await refreshOrderCache(item.orderId);
  res.json({ ok: true });
}));

materialsRouter.delete('/bom/:id', requirePermission('material:edit'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const item = await prisma.bomItem.findUnique({
    where: { id: req.params.id }, include: BOM_HISTORY_COUNT,
  });
  if (!item) throw new NotFoundError('BOM item');
  const blocked = bomRemovalBlocker([toHistory(item)]);
  if (blocked) throw new ConflictError(blocked);
  await prisma.bomItem.delete({ where: { id: item.id } });
  await logActivity({
    orderId: item.orderId, actorId: actor.id, actorName: actor.name,
    action: 'BOM_ITEM_DELETED', summary: `removed ${item.item} from the bill of materials`,
    entityType: 'BomItem', entityId: item.id,
  });
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

  // A line linked to a catalogue material is issued from real stock: through
  // the inventory service, so the shelf, this order's reservation and the
  // movement ledger fall with the issued figure instead of staying put. That
  // service also raises the line's issued figure, inside its own locked
  // transaction, so here only the issue record is written.
  //
  // This route used to write `alreadyIssued + qty` back over it — a total
  // read before the issue — so two issues at once each wrote their own stale
  // sum and one of them vanished from the line while its stock had gone.
  if (item.materialId) {
    await issueToProduction(actor, {
      materialId: item.materialId, orderId: item.orderId, qty: input.qty, unit: item.unit,
      bomItemId: item.id, issuedToName: input.issuedToName ?? null, reason: input.notes ?? null,
      // The log row is written below, with the recipient user as well.
      recordBomIssue: false,
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    // The log entry is the quantity as issued, in the line's unit — the same
    // figure the line rose by — so the issues still add up to the total.
    const issue = await tx.materialIssue.create({
      data: {
        orderId: item.orderId, bomItemId: item.id, qty: input.qty, unit: item.unit,
        issuedById: actor.id, issuedToId: input.issuedToId, issuedToName: input.issuedToName,
        notes: input.notes,
      },
    });
    if (!item.materialId) {
      // Relative, for the same reason: the database adds, nobody's stale total wins.
      await tx.bomItem.update({
        where: { id: item.id },
        data: {
          issuedQty: { increment: input.qty },
          issuedByName: actor.name,
          issuedToName: input.issuedToName ?? item.issuedToName,
          issuedAt: new Date(),
        },
      });
    }
    return issue;
  });
  const after = await prisma.bomItem.findUniqueOrThrow({ where: { id: item.id }, select: { issuedQty: true } });
  const issuedNow = Number(after.issuedQty.toString());

  // The inventory service has already logged a linked line's issue.
  if (!item.materialId) {
    await logActivity({
      orderId: item.orderId, actorId: actor.id, actorName: actor.name,
      action: 'MATERIAL_ISSUED',
      summary: `issued ${input.qty.toLocaleString()} ${item.unit} of ${item.item}${input.issuedToName ? ` to ${input.issuedToName}` : ''}`,
      entityType: 'MaterialIssue', entityId: result.id,
      meta: { item: item.item, qty: input.qty, unit: item.unit, newTotal: issuedNow, required },
    });
  }

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
  res.status(201).json({ id: result.id, newIssuedQty: issuedNow, stillShort });
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
    // The recorded figure, lay allowance included. Without it the plan fell
    // back to layers × marker length and "Fabric required" came out short by
    // the allowance — about 7% on a typical lay plan.
    totalLengthM: dec(m.totalLengthM),
    nestPcs: m.nestPcs, efficiencyPct: dec(m.efficiencyPct),
    maxLayer: m.maxLayer, markerNumber: m.markerNumber, notes: m.notes,
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
    // The sheet's "YXS" is the order's "Youth XS": counted under the order's name.
    plan: computeMarkerPlan(lays, requiredBySize, {
      mainFabric: order.fabric,
      sizeAlias: sizeAliasFor(lays.flatMap((l) => Object.keys(parseSizeRatio(l.ratio))), d.sizes.map((s) => s.name)),
    }),
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
      numberingByName: c.numberingByName, bundledByName: c.bundledByName, approvedByName: c.approvedByName,
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

const layRowSchema = z.object({
  id: z.string().optional(),
  markerNumber: z.string().trim().max(50).optional().nullable(),
  fabricName: z.string().trim().min(1, 'Every lay needs a fabric').max(120),
  fabricColor: z.string().trim().max(120).optional().nullable(),
  panel: z.string().trim().max(60).default('ALL'),
  sizeRatio: z.string().trim().min(1, 'Every lay needs a size ratio').max(500),
  layers: z.number().int().min(0).max(100_000),
  markerLengthM: z.number().min(0).max(100_000),
  totalLengthM: z.number().min(0).max(10_000_000).optional().nullable(),
  nestPcs: z.number().int().min(0).max(100_000).optional().nullable(),
  efficiencyPct: z.number().min(0).max(100).optional().nullable(),
  maxLayer: z.number().int().min(0).max(100_000).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});
const saveLaysSchema = z.object({
  items: z.array(layRowSchema).max(500),
  /** Lays removed in the editor. Only these are deleted: rows the editor did not send are left alone. */
  removeIds: z.array(z.string()).max(500).default([]),
});

/**
 * The lay plan as edited on screen, saved in one go — the Bill of Materials
 * pattern. A row with an id is updated, one without is added at the end, and
 * only the rows the editor removed are deleted, so the panel rows the factory
 * sheet import keeps beside the lays are untouched.
 */
materialsRouter.put('/:orderId/markers', requirePermission('cutting:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = saveLaysSchema.parse(req.body ?? {});
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] }, select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');

  const counts = await prisma.$transaction(async (tx) => {
    const existing = await tx.marker.findMany({ where: { orderId: order.id }, select: { id: true, position: true } });
    const known = new Set(existing.map((m) => m.id));
    let position = existing.length > 0 ? Math.max(...existing.map((m) => m.position)) + 1 : 0;
    let updated = 0, added = 0;
    for (const row of input.items) {
      const { id, ...data } = row;
      if (id) {
        if (!known.has(id)) throw new ValidationError('One of the lays no longer exists on this order. Reload and try again.');
        await tx.marker.update({ where: { id }, data });
        updated++;
      } else {
        await tx.marker.create({ data: { ...data, orderId: order.id, position: position++ } });
        added++;
      }
    }
    const removeIds = input.removeIds.filter((id) => known.has(id));
    const removed = removeIds.length > 0 ? (await tx.marker.deleteMany({ where: { orderId: order.id, id: { in: removeIds } } })).count : 0;
    return { updated, added, removed };
  });

  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'LAY_PLAN_EDITED',
    summary: `edited the lay plan: ${counts.updated} changed, ${counts.added} added, ${counts.removed} removed`,
    entityType: 'Order', entityId: order.id, meta: { ...counts },
  });
  await refreshOrderCache(order.id);
  res.json(counts);
}));

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

/**
 * Remove the whole lay plan, to import or enter a new one from nothing.
 * Markers go, and the cutting and fabric records an import wrote; anything
 * entered by hand stays.
 */
materialsRouter.delete('/:orderId/markers', requirePermission('cutting:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] }, select: { id: true, poNumber: true },
  });
  if (!order) throw new NotFoundError('Order');
  const cleared = await prisma.$transaction((tx) => clearLayPlan(tx, order.id));
  await logActivity({
    orderId: order.id, actorId: actor.id, actorName: actor.name,
    action: 'LAY_PLAN_CLEARED',
    summary: `removed the lay plan: ${cleared.markers} row${cleared.markers === 1 ? '' : 's'}`
      + (cleared.cuttingRecords + cleared.fabricRecords > 0 ? ` and ${cleared.cuttingRecords + cleared.fabricRecords} imported cutting/fabric record${cleared.cuttingRecords + cleared.fabricRecords === 1 ? '' : 's'}` : ''),
    entityType: 'Order', entityId: order.id, meta: { ...cleared },
  });
  await refreshOrderCache(order.id);
  res.json(cleared);
}));

materialsRouter.delete('/markers/:id', requirePermission('cutting:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const marker = await prisma.marker.findUnique({ where: { id: req.params.id } });
  if (!marker) throw new NotFoundError('Marker');
  await prisma.marker.delete({ where: { id: marker.id } });

  // Removing a lay changes whether the plan covers the cut order, so the
  // cached order figures are refreshed and the removal is on the record like
  // every other change to the lay plan.
  await logActivity({
    orderId: marker.orderId, actorId: actor.id, actorName: actor.name,
    action: 'MARKER_REMOVED',
    summary: `removed a lay: ${marker.sizeRatio} × ${marker.layers} layers at ${marker.markerLengthM.toString()} m`,
    entityType: 'Marker', entityId: marker.id,
  });
  await refreshOrderCache(marker.orderId);
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
