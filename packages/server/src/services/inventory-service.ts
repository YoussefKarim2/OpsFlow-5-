/**
 * Inventory service.
 *
 * Every quantity that enters or leaves the factory passes through one of the
 * functions here, and each of them writes exactly two things in one
 * transaction: a `MaterialMovement` row, and the running balance it implies.
 * There is no other way to change stock — no route touches `physicalQty`
 * directly — which is what makes the ledger trustworthy as history rather than
 * merely as a log.
 *
 * The four state transitions the brief asks for, in the order they happen:
 *
 *     receiveStock      →  physical goes up
 *     reserveForOrder   →  available goes down, physical does not move
 *     issueToProduction →  reserved is drawn down AND physical goes down
 *     returnFromProduction → physical goes back up, reservation is restored
 *
 * The middle one is the one factories get wrong. A reservation is a promise,
 * not a withdrawal: the fabric is still on the shelf, and deducting it there
 * means deducting it twice by the time it is actually issued.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  MovementType, ReservationStatus, StockStatus,
  computeStockPosition, computeMaterialPosition, summariseInventory,
  deriveStockStatus, convertQty, unitsCompatible, replayMovements,
  qtyAdd, qtySub, qtyCmp, quantise,
  type StockPosition, type RequirementInput, type MaterialPosition,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { logActivity, logAndNotify } from './activity-service.js';
import type { AuthUser } from '../middleware/auth.js';

type Db = PrismaClient | Prisma.TransactionClient;

const dec = (v: Prisma.Decimal | null | undefined): number | null =>
  v == null ? null : Number(v.toString());
const decOr0 = (v: Prisma.Decimal | null | undefined): number => dec(v) ?? 0;

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

const MATERIAL_INCLUDE = {
  stock: { include: { location: true } },
  reservations: {
    where: { status: ReservationStatus.ACTIVE },
    include: { order: { select: { id: true, poNumber: true, orderName: true } } },
  },
} satisfies Prisma.MaterialInclude;

type MaterialWithStock = Prisma.MaterialGetPayload<{ include: typeof MATERIAL_INCLUDE }>;

export interface MaterialRow {
  id: string;
  code: string | null;
  name: string;
  type: string;
  unit: string;
  colorName: string | null;
  widthCm: number | null;
  composition: string | null;
  gsm: number | null;
  sizeLabel: string | null;
  supplierName: string | null;
  minimumQty: number | null;
  unitCostUsd: number | null;
  active: boolean;
  notes: string | null;
  position: StockPosition;
  locations: Array<{ locationId: string | null; locationName: string | null; qty: number; binRef: string | null }>;
  reservations: Array<{
    id: string; orderId: string; poNumber: string; orderName: string;
    qty: number; consumedQty: number; outstandingQty: number;
  }>;
}

/** Physical stock across all locations, plus the derived position. */
export function toMaterialRow(m: MaterialWithStock): MaterialRow {
  const physicalQty = qtyAdd(...m.stock.map((s) => decOr0(s.physicalQty)));

  const position = computeStockPosition({
    physicalQty,
    reservations: m.reservations.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      qty: decOr0(r.qty),
      consumedQty: decOr0(r.consumedQty),
      active: r.status === ReservationStatus.ACTIVE,
    })),
    minimumQty: dec(m.minimumQty),
  });

  return {
    id: m.id,
    code: m.code,
    name: m.name,
    type: m.type,
    unit: m.unit,
    colorName: m.colorName,
    widthCm: dec(m.widthCm),
    composition: m.composition,
    gsm: m.gsm,
    sizeLabel: m.sizeLabel,
    supplierName: m.supplierName,
    minimumQty: dec(m.minimumQty),
    unitCostUsd: dec(m.unitCostUsd),
    active: m.active,
    notes: m.notes,
    position,
    locations: m.stock.map((s) => ({
      locationId: s.locationId,
      locationName: s.location?.name ?? null,
      qty: decOr0(s.physicalQty),
      binRef: s.binRef,
    })),
    reservations: m.reservations.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      poNumber: r.order.poNumber,
      orderName: r.order.orderName,
      qty: decOr0(r.qty),
      consumedQty: decOr0(r.consumedQty),
      outstandingQty: Math.max(0, qtySub(decOr0(r.qty), decOr0(r.consumedQty))),
    })),
  };
}

export interface ListMaterialsFilters {
  q?: string;
  type?: string;
  status?: StockStatus;
  lowOnly?: boolean;
  activeOnly?: boolean;
}

export async function listMaterials(filters: ListMaterialsFilters = {}): Promise<{
  data: MaterialRow[];
  summary: ReturnType<typeof summariseInventory>;
}> {
  const materials = await prisma.material.findMany({
    where: {
      ...(filters.activeOnly === false ? {} : { active: true }),
      ...(filters.type ? { type: filters.type as never } : {}),
      ...(filters.q
        ? {
            OR: [
              { name: { contains: filters.q, mode: 'insensitive' as const } },
              { code: { contains: filters.q, mode: 'insensitive' as const } },
              { colorName: { contains: filters.q, mode: 'insensitive' as const } },
              { supplierName: { contains: filters.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    include: MATERIAL_INCLUDE,
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });

  const rows = materials.map(toMaterialRow);

  // Status filtering happens here rather than in SQL because status is derived
  // from reservations — it is not a column, and making it one would let it drift.
  const filtered = rows.filter((r) => {
    if (filters.status && r.position.status !== filters.status) return false;
    if (filters.lowOnly && r.position.status === StockStatus.OK) return false;
    return true;
  });

  return {
    data: filtered,
    // Summary counts the whole catalogue, not the filtered view: the tiles are
    // the factory's position, and they must not change when you type in a search box.
    summary: summariseInventory(rows.map((r) => ({ position: r.position, unitCost: r.unitCostUsd }))),
  };
}

export async function getMaterial(id: string): Promise<MaterialRow> {
  const m = await prisma.material.findUnique({ where: { id }, include: MATERIAL_INCLUDE });
  if (!m) throw new NotFoundError('Material');
  return toMaterialRow(m);
}

export async function getMovements(
  materialId: string,
  limit = 100,
): Promise<Array<{
  id: string; type: string; qty: number; signedQty: number; unit: string; balanceAfter: number;
  orderId: string | null; orderPoNumber: string | null; reason: string | null; batchLot: string | null;
  actorName: string; occurredAt: string;
}>> {
  const movements = await prisma.materialMovement.findMany({
    where: { materialId },
    include: { order: { select: { poNumber: true } } },
    orderBy: { occurredAt: 'desc' },
    take: limit,
  });

  return movements.map((m) => {
    const qty = decOr0(m.qty);
    return {
      id: m.id,
      type: m.type,
      qty,
      // Recomputed rather than stored twice: the sign belongs to the type.
      signedQty: m.type === MovementType.ADJUSTMENT ? qty : Math.abs(qty) * (isInbound(m.type) ? 1 : -1),
      unit: m.unit,
      balanceAfter: decOr0(m.balanceAfter),
      orderId: m.orderId,
      orderPoNumber: m.order?.poNumber ?? null,
      reason: m.reason,
      batchLot: m.batchLot,
      actorName: m.actorName,
      occurredAt: m.occurredAt.toISOString(),
    };
  });
}

function isInbound(type: string): boolean {
  return type === MovementType.RECEIPT || type === MovementType.RETURN || type === MovementType.TRANSFER_IN;
}

// ─────────────────────────────────────────────────────────────────────────────
// The one place stock changes
// ─────────────────────────────────────────────────────────────────────────────

interface MovementInput {
  materialId: string;
  locationId?: string | null;
  type: MovementType;
  /** Magnitude, except for ADJUSTMENT which is signed. */
  qty: number;
  unit?: string;
  orderId?: string | null;
  bomItemId?: string | null;
  reservationId?: string | null;
  reason?: string | null;
  batchLot?: string | null;
  reference?: string | null;
  stage?: string | null;
  occurredAt?: Date;
}

/**
 * Write one movement and move the balance with it, atomically.
 *
 * Everything public in this file funnels through here. The balance and the
 * ledger row are written in the same transaction, so there is no window in
 * which one exists without the other — which is the only reason the running
 * balance can be trusted between reconciliations.
 */
async function applyMovement(
  tx: Prisma.TransactionClient,
  actor: AuthUser,
  input: MovementInput,
): Promise<{ movementId: string; balanceAfter: number; signed: number }> {
  const material = await tx.material.findUnique({ where: { id: input.materialId } });
  if (!material) throw new NotFoundError('Material');

  // A quantity in a different unit is converted explicitly or refused. Silently
  // treating 100 yards as 100 metres is a 9% error nobody would ever find.
  const suppliedUnit = (input.unit ?? material.unit).toUpperCase();
  let qty = quantise(input.qty);
  if (suppliedUnit !== material.unit) {
    const converted = convertQty(qty, suppliedUnit, material.unit);
    if (converted == null) {
      throw new ValidationError(
        `${material.name} is held in ${material.unit}, and ${suppliedUnit} cannot be converted to it. ` +
        `Enter the quantity in ${material.unit}.`,
      );
    }
    qty = converted;
  }

  if (input.type !== MovementType.ADJUSTMENT && qty <= 0) {
    throw new ValidationError('Enter a quantity greater than zero.');
  }
  if (input.type === MovementType.ADJUSTMENT && qty === 0) {
    throw new ValidationError('An adjustment of zero changes nothing.');
  }

  const signed =
    input.type === MovementType.ADJUSTMENT ? qty : Math.abs(qty) * (isInbound(input.type) ? 1 : -1);

  // Balance is per (material, location) so two stores cannot overdraw each other.
  const locationId = input.locationId ?? null;
  const stock = await tx.materialStock.findFirst({
    where: { materialId: input.materialId, locationId },
  });
  const before = decOr0(stock?.physicalQty);
  const balanceAfter = qtyAdd(before, signed);

  // Physical stock cannot go negative: there is no such thing as minus forty
  // metres on a shelf. A count that finds less is an ADJUSTMENT to the real
  // figure, not a withdrawal past zero.
  if (qtyCmp(balanceAfter, 0) < 0) {
    throw new ConflictError(
      `That would leave ${material.name} at ${balanceAfter.toLocaleString()} ${material.unit}. ` +
      `Only ${before.toLocaleString()} ${material.unit} is on hand` +
      `${locationId ? ' at this location' : ''}. Record a stock adjustment if the book figure is wrong.`,
    );
  }

  if (stock) {
    await tx.materialStock.update({ where: { id: stock.id }, data: { physicalQty: balanceAfter } });
  } else {
    await tx.materialStock.create({
      data: { materialId: input.materialId, locationId, physicalQty: balanceAfter },
    });
  }

  const movement = await tx.materialMovement.create({
    data: {
      materialId: input.materialId,
      locationId,
      type: input.type,
      qty,
      unit: material.unit,
      balanceAfter,
      orderId: input.orderId ?? null,
      bomItemId: input.bomItemId ?? null,
      reservationId: input.reservationId ?? null,
      reason: input.reason ?? null,
      batchLot: input.batchLot ?? null,
      reference: input.reference ?? null,
      stage: (input.stage ?? null) as never,
      actorId: actor.id,
      actorName: actor.name,
      occurredAt: input.occurredAt ?? new Date(),
    },
  });

  return { movementId: movement.id, balanceAfter, signed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Receipts, adjustments, wastage
// ─────────────────────────────────────────────────────────────────────────────

export async function receiveStock(
  actor: AuthUser,
  input: {
    materialId: string; qty: number; unit?: string; locationId?: string | null;
    batchLot?: string | null; reference?: string | null; reason?: string | null; unitCostUsd?: number | null;
  },
): Promise<MaterialRow> {
  await prisma.$transaction(async (tx) => {
    await applyMovement(tx, actor, {
      ...input,
      type: MovementType.RECEIPT,
      reason: input.reason ?? 'Purchase receipt',
    });
    // A receipt is the moment the real price is known.
    if (input.unitCostUsd != null) {
      await tx.material.update({ where: { id: input.materialId }, data: { unitCostUsd: input.unitCostUsd } });
    }
  });

  const row = await getMaterial(input.materialId);
  await logActivity({
    actorId: actor.id, actorName: actor.name, action: 'STOCK_RECEIVED',
    summary: `received ${input.qty.toLocaleString()} ${row.unit} of ${row.name}`,
    entityType: 'Material', entityId: input.materialId,
    meta: { qty: input.qty, batchLot: input.batchLot ?? null, balance: row.position.physicalQty },
  });
  return row;
}

export async function adjustStock(
  actor: AuthUser,
  input: { materialId: string; qty: number; locationId?: string | null; reason: string },
): Promise<MaterialRow> {
  if (!input.reason?.trim()) {
    // An unexplained adjustment is indistinguishable from a mistake.
    throw new ValidationError('A stock adjustment needs a reason — say what was counted and why it differs.');
  }

  await prisma.$transaction(async (tx) => {
    await applyMovement(tx, actor, { ...input, type: MovementType.ADJUSTMENT });
  });

  const row = await getMaterial(input.materialId);
  await logActivity({
    actorId: actor.id, actorName: actor.name, action: 'STOCK_ADJUSTED',
    summary: `adjusted ${row.name} by ${input.qty > 0 ? '+' : ''}${input.qty.toLocaleString()} ${row.unit} — ${input.reason.trim()}`,
    entityType: 'Material', entityId: input.materialId,
    meta: { qty: input.qty, reason: input.reason.trim(), balance: row.position.physicalQty },
  });
  return row;
}

export async function recordWastage(
  actor: AuthUser,
  input: { materialId: string; qty: number; orderId?: string | null; reason: string; locationId?: string | null },
): Promise<MaterialRow> {
  await prisma.$transaction(async (tx) => {
    await applyMovement(tx, actor, { ...input, type: MovementType.WASTAGE });
  });

  const row = await getMaterial(input.materialId);
  await logActivity({
    orderId: input.orderId ?? null,
    actorId: actor.id, actorName: actor.name, action: 'STOCK_WASTAGE',
    summary: `wrote off ${input.qty.toLocaleString()} ${row.unit} of ${row.name} — ${input.reason}`,
    entityType: 'Material', entityId: input.materialId,
  });
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reservation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Commit stock to an order without moving it.
 *
 * Serialisable, because the check ("is there enough available?") and the write
 * ("there is now less available") must not interleave with another order doing
 * the same thing. Two coordinators reserving the last 1,000 metres at the same
 * moment would otherwise both succeed, and the shortage would surface on the
 * cutting floor rather than on the screen.
 */
export async function reserveForOrder(
  actor: AuthUser,
  input: {
    materialId: string; orderId: string; qty: number; unit?: string;
    bomItemId?: string | null; notes?: string | null;
    /** Reserve whatever is available when the full quantity is not. */
    allowPartial?: boolean;
  },
): Promise<{ reservation: { id: string; qty: number }; material: MaterialRow; partial: boolean }> {
  const result = await prisma.$transaction(
    async (tx) => {
      const material = await tx.material.findUnique({
        where: { id: input.materialId },
        include: MATERIAL_INCLUDE,
      });
      if (!material) throw new NotFoundError('Material');

      const order = await tx.order.findUnique({ where: { id: input.orderId }, select: { poNumber: true } });
      if (!order) throw new NotFoundError('Order');

      let qty = quantise(input.qty);
      const suppliedUnit = (input.unit ?? material.unit).toUpperCase();
      if (suppliedUnit !== material.unit) {
        const converted = convertQty(qty, suppliedUnit, material.unit);
        if (converted == null) {
          throw new ValidationError(
            `${material.name} is held in ${material.unit}; ${suppliedUnit} cannot be converted to it.`,
          );
        }
        qty = converted;
      }
      if (qty <= 0) throw new ValidationError('Enter a quantity greater than zero.');

      const position = toMaterialRow(material).position;

      if (qtyCmp(qty, position.availableQty) > 0) {
        if (!input.allowPartial) {
          throw new ConflictError(
            `Only ${position.availableQty.toLocaleString()} ${material.unit} of ${material.name} is available. ` +
            `${position.physicalQty.toLocaleString()} is on hand but ${position.reservedQty.toLocaleString()} is ` +
            `already reserved for other orders. Reserve the available quantity, or raise a purchase request for the rest.`,
          );
        }
        qty = Math.max(0, position.availableQty);
        if (qty <= 0) {
          throw new ConflictError(
            `None of ${material.name} is available — all ${position.physicalQty.toLocaleString()} ${material.unit} ` +
            `on hand is reserved for other orders.`,
          );
        }
      }

      // One reservation per (material, order, BOM line) — topped up rather than
      // duplicated, so the same requirement reserved twice does not double-count.
      const existing = await tx.materialReservation.findFirst({
        where: {
          materialId: input.materialId,
          orderId: input.orderId,
          bomItemId: input.bomItemId ?? null,
          status: ReservationStatus.ACTIVE,
        },
      });

      const reservation = existing
        ? await tx.materialReservation.update({
            where: { id: existing.id },
            data: { qty: qtyAdd(decOr0(existing.qty), qty) },
          })
        : await tx.materialReservation.create({
            data: {
              materialId: input.materialId,
              orderId: input.orderId,
              bomItemId: input.bomItemId ?? null,
              qty,
              unit: material.unit,
              reservedById: actor.id,
              notes: input.notes ?? null,
            },
          });

      return {
        reservationId: reservation.id,
        reservedQty: qty,
        partial: qtyCmp(qty, quantise(input.qty)) < 0,
        materialName: material.name,
        unit: material.unit,
        poNumber: order.poNumber,
      };
    },
    { isolationLevel: 'Serializable' },
  );

  await logActivity({
    orderId: input.orderId,
    actorId: actor.id, actorName: actor.name, action: 'MATERIAL_RESERVED',
    summary:
      `reserved ${result.reservedQty.toLocaleString()} ${result.unit} of ${result.materialName}` +
      (result.partial ? ' (partial — that is all that was available)' : ''),
    entityType: 'MaterialReservation', entityId: result.reservationId,
    meta: { materialId: input.materialId, qty: result.reservedQty, partial: result.partial },
  });

  return {
    reservation: { id: result.reservationId, qty: result.reservedQty },
    material: await getMaterial(input.materialId),
    partial: result.partial,
  };
}

/** Give committed stock back to the pool without issuing it. */
export async function releaseReservation(
  actor: AuthUser,
  reservationId: string,
  reason?: string,
): Promise<MaterialRow> {
  const reservation = await prisma.materialReservation.findUnique({
    where: { id: reservationId },
    include: { material: { select: { name: true, unit: true } } },
  });
  if (!reservation) throw new NotFoundError('Reservation');
  if (reservation.status !== ReservationStatus.ACTIVE) {
    throw new ConflictError('That reservation is no longer active.');
  }

  await prisma.materialReservation.update({
    where: { id: reservationId },
    data: {
      status: ReservationStatus.RELEASED,
      releasedAt: new Date(),
      releaseReason: reason?.trim() || null,
    },
  });

  const outstanding = Math.max(0, qtySub(decOr0(reservation.qty), decOr0(reservation.consumedQty)));
  await logActivity({
    orderId: reservation.orderId,
    actorId: actor.id, actorName: actor.name, action: 'MATERIAL_RELEASED',
    summary:
      `released ${outstanding.toLocaleString()} ${reservation.material.unit} of ` +
      `${reservation.material.name} back to available stock${reason ? ` — ${reason.trim()}` : ''}`,
    entityType: 'MaterialReservation', entityId: reservationId,
  });

  return getMaterial(reservation.materialId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue and return
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Move material from the shelf to the floor.
 *
 * Draws against this order's reservation first, so the reserved figure falls as
 * the fabric physically leaves. Anything beyond the reservation is allowed —
 * the floor sometimes needs more than planned — but it consumes *available*
 * stock, and if that is not there the issue is refused with the numbers.
 */
export async function issueToProduction(
  actor: AuthUser,
  input: {
    materialId: string; orderId: string; qty: number; unit?: string;
    bomItemId?: string | null; locationId?: string | null;
    stage?: string | null; reason?: string | null; batchLot?: string | null; issuedToName?: string | null;
  },
): Promise<{ material: MaterialRow; drawnFromReservation: number; drawnFromFree: number }> {
  const result = await prisma.$transaction(
    async (tx) => {
      const material = await tx.material.findUnique({
        where: { id: input.materialId },
        include: MATERIAL_INCLUDE,
      });
      if (!material) throw new NotFoundError('Material');

      let qty = quantise(input.qty);
      const suppliedUnit = (input.unit ?? material.unit).toUpperCase();
      if (suppliedUnit !== material.unit) {
        const converted = convertQty(qty, suppliedUnit, material.unit);
        if (converted == null) {
          throw new ValidationError(`${material.name} is held in ${material.unit}; ${suppliedUnit} cannot be converted.`);
        }
        qty = converted;
      }
      if (qty <= 0) throw new ValidationError('Enter a quantity greater than zero.');

      const row = toMaterialRow(material);

      // Reservations for this order, oldest first, so the earliest commitment
      // is honoured first.
      //
      // Scoped to the BOM line when one is given: two lines of the same order
      // can require the same material for different purposes, and drawing one
      // line's issue against the other's reservation would leave the second
      // looking covered when its material has already gone. A reservation with
      // no BOM line is a general allocation to the order and is fair game for
      // either. Without a BOM line, only those general allocations are touched.
      const reservations = await tx.materialReservation.findMany({
        where: {
          materialId: input.materialId,
          orderId: input.orderId,
          status: ReservationStatus.ACTIVE,
          ...(input.bomItemId
            ? { OR: [{ bomItemId: input.bomItemId }, { bomItemId: null }] }
            : { bomItemId: null }),
        },
        orderBy: { createdAt: 'asc' },
      });

      const reservedForThisOrder = qtyAdd(
        ...reservations.map((r) => Math.max(0, qtySub(decOr0(r.qty), decOr0(r.consumedQty)))),
      );
      const drawnFromReservation = Math.min(qty, reservedForThisOrder);
      const drawnFromFree = qtySub(qty, drawnFromReservation);

      // Beyond this order's reservation, the material has to come out of what
      // is genuinely free — not out of another order's commitment.
      if (qtyCmp(drawnFromFree, row.position.availableQty) > 0) {
        throw new ConflictError(
          `Issuing ${qty.toLocaleString()} ${material.unit} of ${material.name} needs ` +
          `${drawnFromFree.toLocaleString()} beyond this order's reservation, but only ` +
          `${row.position.availableQty.toLocaleString()} is unreserved. ` +
          `Release another order's reservation, or record a receipt first.`,
        );
      }

      // Draw down each reservation in turn.
      let remaining = drawnFromReservation;
      let firstReservationId: string | null = null;
      for (const r of reservations) {
        if (qtyIsZeroLocal(remaining)) break;
        const outstanding = Math.max(0, qtySub(decOr0(r.qty), decOr0(r.consumedQty)));
        if (outstanding <= 0) continue;
        const take = Math.min(outstanding, remaining);
        const newConsumed = qtyAdd(decOr0(r.consumedQty), take);
        await tx.materialReservation.update({
          where: { id: r.id },
          data: {
            consumedQty: newConsumed,
            // A reservation fully drawn down is finished, not still pending.
            status: qtyCmp(newConsumed, decOr0(r.qty)) >= 0 ? ReservationStatus.FULFILLED : ReservationStatus.ACTIVE,
          },
        });
        firstReservationId ??= r.id;
        remaining = qtySub(remaining, take);
      }

      await applyMovement(tx, actor, {
        materialId: input.materialId,
        locationId: input.locationId ?? null,
        type: MovementType.ISSUE,
        qty,
        orderId: input.orderId,
        bomItemId: input.bomItemId ?? null,
        reservationId: firstReservationId,
        reason: input.reason ?? `Issued to ${input.stage ? humanStage(input.stage) : 'production'}`,
        batchLot: input.batchLot ?? null,
        stage: input.stage ?? null,
      });

      // Keep the BOM line's issued figure in step, so the existing BOM screen
      // and the new inventory screen never disagree about the same event.
      if (input.bomItemId) {
        const bom = await tx.bomItem.findUnique({ where: { id: input.bomItemId } });
        if (bom) {
          await tx.bomItem.update({
            where: { id: input.bomItemId },
            data: {
              issuedQty: qtyAdd(decOr0(bom.issuedQty), qty),
              issuedAt: new Date(),
              issuedByName: actor.name,
              issuedToName: input.issuedToName ?? bom.issuedToName,
            },
          });
        }
      }

      return {
        drawnFromReservation,
        drawnFromFree,
        materialName: material.name,
        unit: material.unit,
        qty,
      };
    },
    { isolationLevel: 'Serializable', timeout: 20_000 },
  );

  const row = await getMaterial(input.materialId);

  await logActivity({
    orderId: input.orderId,
    actorId: actor.id, actorName: actor.name, action: 'MATERIAL_ISSUED',
    summary:
      `issued ${result.qty.toLocaleString()} ${result.unit} of ${result.materialName}` +
      (input.stage ? ` to ${humanStage(input.stage)}` : '') +
      (input.issuedToName ? ` (${input.issuedToName})` : ''),
    entityType: 'Material', entityId: input.materialId,
    meta: {
      qty: result.qty,
      fromReservation: result.drawnFromReservation,
      fromFreeStock: result.drawnFromFree,
      balance: row.position.physicalQty,
    },
  });

  // Crossing the reorder line is worth telling someone about at the moment it
  // happens, not at the next stock review.
  if (row.position.status === StockStatus.LOW || row.position.status === StockStatus.OUT_OF_STOCK) {
    await logAndNotify(
      {
        orderId: input.orderId,
        actorId: actor.id, actorName: 'System', action: 'STOCK_LOW',
        summary: `${row.name} is now ${row.position.status === StockStatus.OUT_OF_STOCK ? 'out of stock' : 'below its minimum level'}`,
      },
      {
        type: 'MATERIAL_SHORTAGE',
        title: `${row.name} is running low`,
        body:
          `${row.position.availableQty.toLocaleString()} ${row.unit} available` +
          (row.minimumQty != null ? ` against a minimum of ${row.minimumQty.toLocaleString()}` : '') + '.',
        link: `/inventory/materials/${row.id}`,
        departments: ['WAREHOUSE', 'COORDINATOR'],
      },
    );
  }

  return { material: row, drawnFromReservation: result.drawnFromReservation, drawnFromFree: result.drawnFromFree };
}

/** Unused material coming back from the floor: physical up, reservation restored. */
export async function returnFromProduction(
  actor: AuthUser,
  input: {
    materialId: string; orderId: string; qty: number; unit?: string;
    bomItemId?: string | null; locationId?: string | null; reason?: string | null;
  },
): Promise<MaterialRow> {
  await prisma.$transaction(async (tx) => {
    const material = await tx.material.findUnique({ where: { id: input.materialId } });
    if (!material) throw new NotFoundError('Material');

    let qty = quantise(input.qty);
    const suppliedUnit = (input.unit ?? material.unit).toUpperCase();
    if (suppliedUnit !== material.unit) {
      const converted = convertQty(qty, suppliedUnit, material.unit);
      if (converted == null) {
        throw new ValidationError(`${material.name} is held in ${material.unit}; ${suppliedUnit} cannot be converted.`);
      }
      qty = converted;
    }
    if (qty <= 0) throw new ValidationError('Enter a quantity greater than zero.');

    // Returning more than was issued means one of the two figures is wrong, and
    // guessing which would corrupt the ledger.
    const issued = await tx.materialMovement.aggregate({
      where: { materialId: input.materialId, orderId: input.orderId, type: MovementType.ISSUE },
      _sum: { qty: true },
    });
    const returned = await tx.materialMovement.aggregate({
      where: { materialId: input.materialId, orderId: input.orderId, type: MovementType.RETURN },
      _sum: { qty: true },
    });
    const netIssued = qtySub(decOr0(issued._sum.qty), decOr0(returned._sum.qty));
    if (qtyCmp(qty, netIssued) > 0) {
      throw new ConflictError(
        `Only ${netIssued.toLocaleString()} ${material.unit} of ${material.name} is out against this order, ` +
        `so ${qty.toLocaleString()} cannot come back. Record a receipt if this is new stock.`,
      );
    }

    // Put it back on the reservation it came off, so the order keeps its claim
    // rather than the metres silently becoming available to everyone else.
    const fulfilled = await tx.materialReservation.findFirst({
      where: {
        materialId: input.materialId,
        orderId: input.orderId,
        status: { in: [ReservationStatus.ACTIVE, ReservationStatus.FULFILLED] },
        consumedQty: { gt: 0 },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (fulfilled) {
      const restored = Math.max(0, qtySub(decOr0(fulfilled.consumedQty), qty));
      await tx.materialReservation.update({
        where: { id: fulfilled.id },
        data: {
          consumedQty: restored,
          status: qtyCmp(restored, decOr0(fulfilled.qty)) >= 0
            ? ReservationStatus.FULFILLED
            : ReservationStatus.ACTIVE,
        },
      });
    }

    await applyMovement(tx, actor, {
      materialId: input.materialId,
      locationId: input.locationId ?? null,
      type: MovementType.RETURN,
      qty,
      orderId: input.orderId,
      bomItemId: input.bomItemId ?? null,
      reservationId: fulfilled?.id ?? null,
      reason: input.reason ?? 'Returned unused from production',
    });

    if (input.bomItemId) {
      const bom = await tx.bomItem.findUnique({ where: { id: input.bomItemId } });
      if (bom) {
        await tx.bomItem.update({
          where: { id: input.bomItemId },
          data: { issuedQty: Math.max(0, qtySub(decOr0(bom.issuedQty), qty)) },
        });
      }
    }
  }, { isolationLevel: 'Serializable' });

  const row = await getMaterial(input.materialId);
  await logActivity({
    orderId: input.orderId,
    actorId: actor.id, actorName: actor.name, action: 'MATERIAL_RETURNED',
    summary: `returned ${input.qty.toLocaleString()} ${row.unit} of ${row.name} to stock`,
    entityType: 'Material', entityId: input.materialId,
    meta: { qty: input.qty, balance: row.position.physicalQty },
  });
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Order-level material position
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where one order stands on materials: what it needs, what is secured, what is
 * genuinely short, and what could be reserved with a click.
 */
export async function getOrderMaterialPosition(orderId: string, db: Db = prisma): Promise<MaterialPosition> {
  const bomItems = await db.bomItem.findMany({
    where: { orderId },
    include: {
      material: { include: MATERIAL_INCLUDE },
      reservations: { where: { status: ReservationStatus.ACTIVE } },
    },
    orderBy: { position_: 'asc' },
  });

  const inputs: RequirementInput[] = bomItems.map((b) => {
    const reservedQty = qtyAdd(
      ...b.reservations.map((r) => Math.max(0, qtySub(decOr0(r.qty), decOr0(r.consumedQty)))),
    );
    const availableQty = b.material ? toMaterialRow(b.material).position.availableQty : null;

    return {
      id: b.id,
      materialId: b.materialId,
      materialName: b.material?.name ?? b.item,
      unit: b.unit,
      requiredQty: decOr0(b.requiredQty),
      reservedQty,
      issuedQty: decOr0(b.issuedQty),
      availableQty,
    };
  });

  return computeMaterialPosition(inputs);
}

/**
 * Reserve everything an order needs, in one go — the brief's §10, run when an
 * order is confirmed.
 *
 * Partial by design: reserving what exists and reporting the rest as short is
 * more useful than refusing the whole operation because one trim is missing.
 */
export async function reserveOrderMaterials(
  actor: AuthUser,
  orderId: string,
): Promise<{
  reserved: Array<{ materialName: string; qty: number; unit: string }>;
  short: Array<{ materialName: string; shortQty: number; unit: string }>;
  skipped: number;
}> {
  const position = await getOrderMaterialPosition(orderId);
  const reserved: Array<{ materialName: string; qty: number; unit: string }> = [];
  const short: Array<{ materialName: string; shortQty: number; unit: string }> = [];
  let skipped = 0;

  for (const r of position.requirements) {
    if (r.status === 'COVERED') continue;
    if (r.materialId == null) { skipped++; continue; }

    if (r.reservableQty > 0) {
      await reserveForOrder(actor, {
        materialId: r.materialId,
        orderId,
        qty: r.reservableQty,
        bomItemId: r.id,
        allowPartial: true,
        notes: 'Reserved automatically when the order was confirmed',
      });
      reserved.push({ materialName: r.materialName, qty: r.reservableQty, unit: r.unit });
    }
    if (r.shortQty > 0) {
      short.push({ materialName: r.materialName, shortQty: r.shortQty, unit: r.unit });
    }
  }

  await logActivity({
    orderId,
    actorId: actor.id, actorName: actor.name, action: 'MATERIALS_RESERVED_BULK',
    summary:
      `reserved materials for the order — ${reserved.length} line${reserved.length === 1 ? '' : 's'} secured` +
      (short.length > 0 ? `, ${short.length} short` : '') +
      (skipped > 0 ? `, ${skipped} not linked to stock` : ''),
    entityType: 'Order', entityId: orderId,
    meta: { reservedCount: reserved.length, shortCount: short.length, skipped },
  });

  return { reserved, short, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recompute every balance from the movement ledger and report the drift.
 *
 * The running balance in `MaterialStock` is a performance shortcut, and any
 * shortcut around a source of truth needs a way to be checked against it. This
 * is that way: it re-derives each material's physical stock from its movements
 * and reports — or, when asked, corrects — any difference.
 *
 * A non-empty result is a bug, not a routine finding.
 */
export async function reconcileStock(
  actor: AuthUser,
  options: { fix?: boolean } = {},
): Promise<{
  checked: number;
  drifted: Array<{ materialId: string; materialName: string; stored: number; ledger: number; difference: number }>;
  fixed: boolean;
}> {
  const materials = await prisma.material.findMany({
    include: { stock: true, movements: { select: { id: true, type: true, qty: true, occurredAt: true } } },
  });

  const drifted: Array<{ materialId: string; materialName: string; stored: number; ledger: number; difference: number }> = [];

  for (const m of materials) {
    const stored = qtyAdd(...m.stock.map((s) => decOr0(s.physicalQty)));
    const ledger = replayMovements(
      m.movements.map((mv) => ({
        id: mv.id, type: mv.type as MovementType, qty: decOr0(mv.qty), occurredAt: mv.occurredAt,
      })),
    );

    if (qtyCmp(stored, ledger) !== 0) {
      drifted.push({
        materialId: m.id,
        materialName: m.name,
        stored,
        ledger,
        difference: qtySub(ledger, stored),
      });

      if (options.fix) {
        // The ledger wins. It is the record of what actually happened.
        const primary = m.stock[0];
        if (primary) {
          await prisma.materialStock.update({
            where: { id: primary.id },
            data: { physicalQty: qtyAdd(decOr0(primary.physicalQty), qtySub(ledger, stored)) },
          });
        } else {
          await prisma.materialStock.create({ data: { materialId: m.id, physicalQty: ledger } });
        }
      }
    }
  }

  if (drifted.length > 0) {
    await logActivity({
      actorId: actor.id, actorName: actor.name,
      action: options.fix ? 'STOCK_RECONCILED' : 'STOCK_DRIFT_DETECTED',
      summary:
        `${options.fix ? 'reconciled' : 'found drift on'} ${drifted.length} material` +
        `${drifted.length === 1 ? '' : 's'} against the movement ledger`,
      meta: { drifted: drifted.map((d) => ({ id: d.materialId, difference: d.difference })) },
    });
  }

  return { checked: materials.length, drifted, fixed: options.fix === true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Local zero test — the shared one takes the same rounding but reads oddly inline. */
function qtyIsZeroLocal(v: number): boolean {
  return qtyCmp(v, 0) === 0;
}

function humanStage(stage: string): string {
  return stage.replace(/_/g, ' ').toLowerCase();
}

export { deriveStockStatus, unitsCompatible };
