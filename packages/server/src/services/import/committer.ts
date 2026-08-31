/**
 * Import commit — step 5 of the pipeline.
 *
 * Takes a validated extraction and creates the order and all related records in
 * a single transaction. All-or-nothing: a file that fails halfway leaves no
 * partial order behind, which is the failure mode that makes people distrust
 * importers and go back to copy-paste.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import { computeCutMatrix, isValidDate, type QtyCell, type AxisRef } from '@opsflow/shared';
import type { ExtractionResult } from './extractor.js';
import { materialiseWorkflow } from '../workflow-service.js';
import { logActivity } from '../activity-service.js';
import { ValidationError } from '../../errors.js';
import { suppressChangeEvents } from '../../request-context.js';
import { normalisePoNumber } from '../rules.js';

export interface CommitOptions {
  actorId: string;
  actorName: string;
  /** Generate the CUT ledger from ORDER − STOCK × (1 + cut%) after import. */
  generateCutOrder?: boolean;
}

export interface CommitResult {
  orderId: string;
  poNumber: string;
  created: {
    colors: number;
    sizes: number;
    quantityCells: number;
    bomItems: number;
    markers: number;
    tasks: number;
  };
}

const BOM_CATEGORY_MAP: Record<string, string> = {
  'fabric': 'FABRIC', 'thread': 'THREAD', 'label': 'LABEL', 'transfer': 'TRANSFER',
  'badge': 'BADGE', 'authantic bdge': 'BADGE', 'logo': 'LOGO', 'sponser': 'SPONSOR',
  'sponsor': 'SPONSOR', 'size': 'SIZE', 'poly bag': 'POLY_BAG', 'poly bag size': 'POLY_BAG',
  'butter paper': 'BUTTER_PAPER', 'sticky tape': 'STICKY_TAPE', 'barcode paper': 'BARCODE_PAPER',
  'half box': 'HALF_BOX', 'dzn. box': 'HALF_BOX', 'carton': 'CARTON', 'tape': 'TAPE',
  'elastic': 'ACCESSORY', 'tie cord': 'ACCESSORY', 'hang tag': 'ACCESSORY',
  'washing inst.': 'ACCESSORY', 'number': 'ACCESSORY', 'sponge': 'ACCESSORY',
  'hologrram': 'ACCESSORY', 'side woven': 'ACCESSORY', 'yoko': 'ACCESSORY',
};

function mapBomCategory(raw: string | null): string {
  if (!raw) return 'OTHER';
  return BOM_CATEGORY_MAP[raw.trim().toLowerCase()] ?? 'OTHER';
}

/** Find or create reference rows, so an import never fails on an unseen colour. */
async function upsertRefColor(tx: Prisma.TransactionClient, name: string, position: number): Promise<string> {
  const clean = name.trim();
  const existing = await tx.refColor.findFirst({ where: { name: { equals: clean, mode: 'insensitive' } } });
  if (existing) return existing.id;
  const created = await tx.refColor.create({ data: { name: clean, position: 900 + position } });
  return created.id;
}

async function upsertRefSize(tx: Prisma.TransactionClient, name: string, position: number): Promise<string> {
  const clean = name.trim();
  const existing = await tx.refSize.findFirst({ where: { name: { equals: clean, mode: 'insensitive' } } });
  if (existing) return existing.id;
  const created = await tx.refSize.create({ data: { name: clean, position: 900 + position } });
  return created.id;
}

async function upsertClient(tx: Prisma.TransactionClient, name: string, shipping: string | null, billing: string | null): Promise<string> {
  const clean = name.trim();
  const existing = await tx.client.findFirst({ where: { name: { equals: clean, mode: 'insensitive' } } });
  if (existing) return existing.id;
  const created = await tx.client.create({
    data: { name: clean, shippingAddress: shipping, billingAddress: billing },
  });
  return created.id;
}

async function upsertFactory(tx: Prisma.TransactionClient, name: string | null, isExternal: boolean): Promise<string | null> {
  if (!name?.trim()) return null;
  const clean = name.trim();
  const existing = await tx.factory.findFirst({ where: { name: { equals: clean, mode: 'insensitive' } } });
  if (existing) return existing.id;
  const created = await tx.factory.create({ data: { name: clean, isExternal } });
  return created.id;
}

/** Match a person named in the sheet to a system user, by name. */
async function findUserByName(tx: Prisma.TransactionClient, name: unknown): Promise<string | null> {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) return null;
  const user = await tx.user.findFirst({
    where: { name: { equals: clean, mode: 'insensitive' }, active: true },
    select: { id: true },
  });
  return user?.id ?? null;
}

export async function commitImport(
  prisma: PrismaClient,
  extraction: ExtractionResult,
  options: CommitOptions,
): Promise<CommitResult> {
  // One import creates an order, its colours, sizes, quantity cells, BOM lines,
  // markers and external operations — several hundred rows. Announcing each as
  // its own change would bury a day's real work under one file. The audit trail
  // still records everything; the *news* is written once, below.
  suppressChangeEvents();

  const errors = extraction.issues.filter((i) => i.level === 'ERROR');
  if (errors.length > 0) {
    throw new ValidationError(
      `This file cannot be imported: ${errors.length} error${errors.length === 1 ? '' : 's'} must be resolved first.`,
      { issues: errors },
    );
  }

  const f = extraction.fields;
  const poNumber = normalisePoNumber(String(f.poNumber ?? ''));

  const clash = await prisma.order.findUnique({ where: { poNumber }, select: { id: true } });
  if (clash) {
    throw new ValidationError(`PO ${poNumber} already exists in the system.`, { orderId: clash.id });
  }

  const orderMatrix = extraction.matrices.find((m) => m.ledger === 'ORDER');
  const stockMatrix = extraction.matrices.find((m) => m.ledger === 'STOCK');
  if (!orderMatrix) throw new ValidationError('No order quantity matrix was found in the file.');

  // `f.poDate` reaches here from the extractor, which now returns only valid
  // dates or null — but this is the one place that does *arithmetic* on it, and
  // `invalidDate.getTime()` is NaN, which would make the shipping date an
  // Invalid Date and push the failure into the database instead of the parser.
  // Belt and braces, because the cost of being wrong here is a bad order.
  const poDate = isValidDate(f.poDate) ? f.poDate : new Date();
  const shipDate = isValidDate(f.promisedShippingDate)
    ? f.promisedShippingDate
    : new Date(poDate.getTime() + 30 * 86_400_000);
  const cutPct = typeof f.cutPercentage === 'number' ? f.cutPercentage : 0.05;

  const result = await prisma.$transaction(async (tx) => {
    const clientId = await upsertClient(
      tx, String(f.clientName ?? 'Unknown client'),
      f.shippingAddress ? String(f.shippingAddress) : null,
      f.billingAddress ? String(f.billingAddress) : null,
    );
    const externalFactoryId = await upsertFactory(tx, f.externalFactoryName ? String(f.externalFactoryName) : null, true);
    const coordinatorId = await findUserByName(tx, f.coordinatorName);
    const outsideWorkManagerId = await findUserByName(tx, f.outsideWorkManager);

    const order = await tx.order.create({
      data: {
        poNumber,
        orderName: String(f.orderName ?? poNumber),
        season: String(f.season ?? 'Unspecified'),
        clientId,
        externalFactoryId,
        coordinatorId,
        outsideWorkManagerId,
        itemType: f.itemType ? String(f.itemType) : null,
        gender: f.gender ? String(f.gender) : null,
        styleNumber: f.styleNumber ? String(f.styleNumber) : null,
        fit: f.fit ? String(f.fit) : null,
        blockPattern: f.blockPattern ? String(f.blockPattern) : null,
        fabric: f.fabric ? String(f.fabric) : null,
        shippingMethod: f.shippingMethod ? String(f.shippingMethod) : null,
        pricePerPieceUsd: typeof f.pricePerPieceUsd === 'number' ? f.pricePerPieceUsd : null,
        cutPercentage: cutPct,
        accessoryPercentage: typeof f.accessoryPercentage === 'number' ? f.accessoryPercentage : 0.05,
        poDate,
        promisedShippingDate: shipDate,
        requiredDeliveryDate: (f.requiredDeliveryDate as Date) ?? shipDate,
        externalWorkSort: f.externalWorkSort ? String(f.externalWorkSort) : null,
        externalWorkType: f.externalWorkType ? String(f.externalWorkType) : null,
        shippingAddress: f.shippingAddress ? String(f.shippingAddress) : null,
        billingAddress: f.billingAddress ? String(f.billingAddress) : null,
      },
    });

    // ── Axes ──────────────────────────────────────────────────────────────
    const colorIds = new Map<string, string>();
    for (const [i, row] of orderMatrix.rows.entries()) {
      const refId = await upsertRefColor(tx, row.color, i);
      const oc = await tx.orderColor.create({
        data: { orderId: order.id, colorId: refId, position: i },
      });
      colorIds.set(row.color, oc.id);
    }

    const sizeIds = new Map<string, string>();
    for (const [i, name] of orderMatrix.sizes.entries()) {
      const refId = await upsertRefSize(tx, name, i);
      const os = await tx.orderSize.create({ data: { orderId: order.id, sizeId: refId, position: i } });
      sizeIds.set(name, os.id);
    }

    // ── Quantities ────────────────────────────────────────────────────────
    const qtyRows: Prisma.StageQuantityCreateManyInput[] = [];

    for (const row of orderMatrix.rows) {
      const orderColorId = colorIds.get(row.color);
      if (!orderColorId) continue;
      for (const [size, qty] of Object.entries(row.cells)) {
        const orderSizeId = sizeIds.get(size);
        if (!orderSizeId || qty <= 0) continue;
        qtyRows.push({ orderId: order.id, orderColorId, orderSizeId, ledger: 'ORDER', qty: Math.round(qty) });
      }
    }

    for (const row of stockMatrix?.rows ?? []) {
      const orderColorId = colorIds.get(row.color);
      if (!orderColorId) continue;
      for (const [size, qty] of Object.entries(row.cells)) {
        const orderSizeId = sizeIds.get(size);
        if (!orderSizeId || qty <= 0) continue;
        qtyRows.push({ orderId: order.id, orderColorId, orderSizeId, ledger: 'STOCK', qty: Math.round(qty) });
      }
    }

    if (qtyRows.length > 0) await tx.stageQuantity.createMany({ data: qtyRows });

    // The cut order is recomputed, never imported: a stored cut figure in the
    // file may predate the last change to the order or the stock.
    let cutCells: QtyCell[] = [];
    if (options.generateCutOrder !== false) {
      const axesColors: AxisRef[] = [...colorIds.entries()].map(([name, id], i) => ({ id, name, position: i }));
      const axesSizes: AxisRef[] = [...sizeIds.entries()].map(([name, id], i) => ({ id, name, position: i }));
      const cells: QtyCell[] = qtyRows.map((q) => ({
        colorId: q.orderColorId, sizeId: q.orderSizeId, ledger: q.ledger as 'ORDER' | 'STOCK', qty: q.qty ?? 0,
      }));
      cutCells = computeCutMatrix(cells, axesColors, axesSizes, cutPct);
      if (cutCells.length > 0) {
        await tx.stageQuantity.createMany({
          data: cutCells.map((c) => ({
            orderId: order.id, orderColorId: c.colorId, orderSizeId: c.sizeId, ledger: 'CUT' as const, qty: c.qty,
          })),
        });
      }
    }

    // ── Notes ─────────────────────────────────────────────────────────────
    const notes: Array<[string, unknown]> = [
      ['GENERAL', f.generalNotes], ['SPREAD', f.spreadNotes], ['CUT', f.cutNotes],
      ['PACKING', f.packingNotes], ['EXTERNAL', f.externalNotes],
    ];
    for (const [kind, body] of notes) {
      const text = typeof body === 'string' ? body.trim() : '';
      if (text) {
        await tx.orderNote.create({ data: { orderId: order.id, kind: kind as never, body: text } });
      }
    }

    // ── BOM ───────────────────────────────────────────────────────────────
    let bomCount = 0;
    for (const [i, line] of extraction.bom.entries()) {
      if (!line.item && !line.category) continue;
      await tx.bomItem.create({
        data: {
          orderId: order.id,
          category: mapBomCategory(line.category) as never,
          position: line.position,
          item: line.item ?? line.category ?? 'Unnamed item',
          description: line.description,
          colorText: line.color,
          consumptionPerPiece: line.consumptionPerPiece,
          requiredQty: line.requiredQty ?? 0,
          unit: line.unit ?? 'Pcs',
          issuedQty: line.issuedQty ?? 0,
          issuedByName: line.issuedBy,
          issuedToName: line.issuedTo,
          position_: i,
        },
      });
      bomCount++;
    }

    // ── Markers ───────────────────────────────────────────────────────────
    let markerCount = 0;
    for (const [i, lay] of extraction.lays.entries()) {
      if (!lay.sizeRatio || !lay.layers) continue;
      await tx.marker.create({
        data: {
          orderId: order.id,
          fabricName: lay.fabric ?? String(f.fabric ?? 'Unspecified'),
          fabricColor: lay.color,
          panel: lay.panel ?? 'ALL',
          sizeRatio: lay.sizeRatio,
          layers: lay.layers,
          markerLengthM: lay.markerLengthM ?? 0,
          nestPcs: lay.nestPcs,
          position: i,
        },
      });
      markerCount++;
    }

    // ── Costing ───────────────────────────────────────────────────────────
    if (Object.values(extraction.costing).some((v) => v != null)) {
      await tx.costingRecord.create({
        data: {
          orderId: order.id,
          dollarRate: extraction.costing.dollarRate ?? 48.5,
          dailyCostEgp: extraction.costing.dailyCostEgp,
          machineCount: extraction.costing.machineCount ? Math.round(extraction.costing.machineCount) : null,
          machineDaysUsed: extraction.costing.machineDaysUsed ? Math.round(extraction.costing.machineDaysUsed) : null,
          daysInLine: extraction.costing.daysInLine ? Math.round(extraction.costing.daysInLine) : null,
        },
      });
    }

    // ── Workflow ──────────────────────────────────────────────────────────
    const wf = await materialiseWorkflow(tx, order.id, {
      poDate, promisedShippingDate: shipDate, coordinatorId, outsideWorkManagerId,
    });

    await logActivity({
      orderId: order.id, actorId: options.actorId, actorName: options.actorName,
      action: 'ORDER_IMPORTED',
      summary:
        `imported ${poNumber} from Excel — ${orderMatrix.computedTotal.toLocaleString()} pcs across ` +
        `${orderMatrix.rows.length} colours, ${bomCount} BOM lines, ${markerCount} lays`,
      entityType: 'Order', entityId: order.id,
      meta: { profile: extraction.profileKey, confidence: extraction.confidence },
    }, tx);

    return {
      orderId: order.id,
      poNumber,
      created: {
        colors: colorIds.size,
        sizes: sizeIds.size,
        quantityCells: qtyRows.length + cutCells.length,
        bomItems: bomCount,
        markers: markerCount,
        tasks: wf.tasksCreated,
      },
    };
  }, { timeout: 30_000 });

  return result;
}
