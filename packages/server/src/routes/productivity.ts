/**
 * Factory productivity.
 *
 * A factory-wide view built from the records the orders already hold —
 * production entries, quality audits, cutting records, shipments — plus the
 * one thing a sewing floor records that no order does: the day log of who
 * was on the floor and for how long. From those, the measures the trade
 * manages by:
 *
 *   line efficiency, pieces per operator and per machine (day log + SAM),
 *   DHU — defects per hundred units (audits),
 *   on-time delivery and cut-to-ship (shipments and ledgers),
 *   output by stage, never summed across stages.
 *
 * Every figure is a calculation over entered records, and a figure the
 * records cannot support is null with a stated reason — never an estimate.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  ProductionOperation, QtyLedger, computeAudit,
  isDayKey, daysInRange, previousRange, rangeBounds, compareTrend,
  summariseOutput, summariseByOrder, summariseDefectRate, summariseFabricUtilisation, summariseFactory,
  summariseLabour, summariseDelivery, summariseRft,
  PRIMARY_OPERATION, PRODUCTION_OPERATIONS,
  type ProductivityDto, type ProductivityRecordDto, type ProductivityOrderRowDto, type ProductivityDayLogDto,
  type ProductivityAuditRowDto, type ProductivityCuttingRowDto, type DayRange, type Permission,
} from '@opsflow/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { ValidationError } from '../errors.js';

export const productivityRouter = Router();
productivityRouter.use(authenticate);

/** The permission that opens the page: reading production is what it does. */
export const PRODUCTIVITY_PERMISSION: Permission = 'production:read';

/** A year is the most anyone needs on one screen, and the most one query should carry. */
export const MAX_RANGE_DAYS = 366;

const dayKey = z.string().refine(isDayKey, { message: 'Enter a date as YYYY-MM-DD.' });

export const productivityQuery = z.object({
  from: dayKey,
  to: dayKey,
  primary: z.enum(PRODUCTION_OPERATIONS as [ProductionOperation, ...ProductionOperation[]]).optional(),
});

/** Validate the requested range: ordered, and no longer than a year. */
export function parseRange(input: { from: string; to: string }): DayRange {
  if (input.from > input.to) throw new ValidationError('The start of the range must not be after its end.');
  const range = { from: input.from, to: input.to };
  if (daysInRange(range) > MAX_RANGE_DAYS) {
    throw new ValidationError(`Choose a range of at most ${MAX_RANGE_DAYS} days.`);
  }
  return range;
}

/**
 * Which sections an account may see. Output and labour need production:read,
 * which the route already requires; the defect rate, fabric and delivery
 * figures are quality, cutting and shipment information and follow those
 * permissions, the same as the tabs that show the underlying records.
 */
export function sectionsFor(permissions: readonly string[]): { quality: boolean; fabric: boolean; delivery: boolean } {
  return {
    quality: permissions.includes('quality:read'),
    fabric: permissions.includes('cutting:read'),
    delivery: permissions.includes('shipment:read'),
  };
}

/**
 * A day log as the form sends it. Every field may be blank — a half-filled
 * sheet is recorded as exactly that — but a figure that is there must be a
 * whole, plausible number: nobody has 10,000 operators or a 30-hour day.
 */
const count = (max: number) => z.preprocess(
  (v) => (v === '' || v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? null : v),
  z.number().int().min(0).max(max).nullable(),
);
export const dayLogSchema = z.object({
  operators: count(5000),
  helpers: count(5000),
  workingMinutes: count(24 * 60),
  machinesRunning: count(5000),
  notes: z.string().max(2000).nullable().optional(),
});

const dec = (v: Prisma.Decimal | null | undefined): number | null => (v == null ? null : Number(v.toString()));

const ORDER_REF = { select: {
  id: true, poNumber: true, orderName: true, samMinutes: true,
  client: { select: { name: true } }, factory: { select: { name: true } },
} } as const;

const toDayLogDto = (l: {
  date: Date; operators: number | null; helpers: number | null; workingMinutes: number | null;
  machinesRunning: number | null; notes: string | null;
}): ProductivityDayLogDto => ({
  date: l.date.toISOString().slice(0, 10),
  operators: l.operators, helpers: l.helpers, workingMinutes: l.workingMinutes,
  machinesRunning: l.machinesRunning, notes: l.notes,
});

productivityRouter.get('/', requirePermission(PRODUCTIVITY_PERMISSION), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const q = productivityQuery.parse(req.query);
  const range = parseRange(q);
  const previous = previousRange(range);
  const primary = q.primary ?? PRIMARY_OPERATION;
  const sections = sectionsFor(actor.permissions);

  // One query spans both periods; the aggregation ignores anything outside
  // the range it is given, so the same rows feed the current and the previous.
  const span = { start: rangeBounds(previous).start, end: rangeBounds(range).end };
  const current = rangeBounds(range);

  const [production, dayLogs, audits, cutting, shipments] = await Promise.all([
    prisma.productionRecord.findMany({
      where: { date: { gte: span.start, lt: span.end } },
      include: { order: ORDER_REF },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.productionDayLog.findMany({
      where: { date: { gte: span.start, lt: span.end } },
      orderBy: { date: 'asc' },
    }),
    sections.quality
      ? prisma.qualityAudit.findMany({
          where: { inspectionDate: { gte: current.start, lt: current.end } },
          include: { defects: true, order: ORDER_REF },
          orderBy: { inspectionDate: 'asc' },
        })
      : Promise.resolve(null),
    sections.fabric
      ? prisma.cuttingRecord.findMany({
          where: { cutDate: { gte: current.start, lt: current.end } },
          include: { order: ORDER_REF },
          orderBy: { cutDate: 'asc' },
        })
      : Promise.resolve(null),
    sections.delivery
      ? prisma.shipment.findMany({
          where: { actualShippingDate: { gte: current.start, lt: current.end } },
          select: {
            id: true, orderId: true, qty: true, actualShippingDate: true, promisedShippingDate: true,
            order: { select: { promisedShippingDate: true } },
          },
        })
      : Promise.resolve(null),
  ]);

  const inputs = production.map((p) => ({
    id: p.id, orderId: p.orderId, date: p.date, operation: p.operation, qty: p.qty, line: p.line, team: p.team,
  }));
  const sams = [...new Map(production.map((p) => [p.orderId, { orderId: p.orderId, samMinutes: dec(p.order.samMinutes) }])).values()];
  const logInputs = dayLogs.map((l) => ({
    date: l.date, operators: l.operators, helpers: l.helpers, workingMinutes: l.workingMinutes, machinesRunning: l.machinesRunning,
  }));

  const output = summariseOutput(inputs, range, primary);
  const before = summariseOutput(inputs, previous, primary);
  const overview = summariseFactory(inputs, range);
  const overviewBefore = summariseFactory(inputs, previous);
  const labour = summariseLabour(inputs, logInputs, sams, range);
  const labourBefore = summariseLabour(inputs, logInputs, sams, previous);

  const orderById = new Map(production.map((p) => [p.orderId, p.order]));
  const orders: ProductivityOrderRowDto[] = summariseByOrder(inputs, range, primary).map((row) => {
    const o = orderById.get(row.orderId)!;
    return {
      ...row,
      poNumber: o.poNumber, orderName: o.orderName,
      clientName: o.client.name, factoryName: o.factory?.name ?? null,
      samMinutes: dec(o.samMinutes),
    };
  });

  const records: ProductivityRecordDto[] = production
    .filter((p) => p.date >= current.start && p.date < current.end)
    .map((p) => ({
      id: p.id, orderId: p.orderId, poNumber: p.order.poNumber, orderName: p.order.orderName,
      date: p.date.toISOString(), operation: p.operation, qty: p.qty, line: p.line, team: p.team,
    }));

  let quality: ProductivityDto['quality'] = null;
  if (audits) {
    // The same fill-in the Quality tab applies: a stored sample or defect count
    // wins; otherwise the AQL table and the defect list supply them. The stored
    // `rejectedQty` is the defect total (computeAudit sets it to totalDefects),
    // which is why it is carried here as `defectQty`.
    const rows = audits.map((a) => {
      const computed = computeAudit({
        availableQty: a.availableQty,
        sampleSize: a.sampleSize,
        defects: a.defects.map((d) => ({ category: d.category, qty: d.qty, comment: d.comment })),
        manualResult: a.overridden ? (a.result as 'PASS' | 'FAIL') : null,
      });
      return {
        id: a.id, orderId: a.orderId, order: a.order,
        inspectionDate: a.inspectionDate, auditType: a.auditType,
        sampleSize: a.sampleSize ?? computed.sampleSize,
        defectQty: a.rejectedQty ?? computed.rejectedQty,
        result: a.result as 'PASS' | 'FAIL' | 'PENDING',
        isReinspection: a.reinspectionOf != null,
      };
    });
    const summary = summariseDefectRate(rows, range);
    const rft = summariseRft(rows, range);
    const auditRows: ProductivityAuditRowDto[] = rows.map((r) => ({
      id: r.id, orderId: r.orderId, poNumber: r.order.poNumber, orderName: r.order.orderName,
      inspectionDate: r.inspectionDate.toISOString(), auditType: r.auditType,
      sampleSize: r.sampleSize, defectQty: r.defectQty, result: r.result, isReinspection: r.isReinspection,
      counted: r.sampleSize != null && r.sampleSize > 0 && r.defectQty != null,
    }));
    quality = { summary, rft, audits: auditRows };
  }

  let fabric: ProductivityDto['fabric'] = null;
  if (cutting) {
    const rows = cutting.map((c) => ({
      id: c.id, orderId: c.orderId, order: c.order, cutDate: c.cutDate,
      actualCutQty: c.actualCutQty, fabricUsedM: dec(c.fabricUsedM),
    }));
    const summary = summariseFabricUtilisation(rows, range);
    const cuttingRows: ProductivityCuttingRowDto[] = rows
      .filter((r) => r.cutDate != null)
      .map((r) => ({
        id: r.id, orderId: r.orderId, poNumber: r.order.poNumber, orderName: r.order.orderName,
        cutDate: r.cutDate!.toISOString(), actualCutQty: r.actualCutQty, fabricUsedM: r.fabricUsedM,
        counted: r.actualCutQty != null && r.actualCutQty > 0 && r.fabricUsedM != null && r.fabricUsedM >= 0,
      }));
    fabric = { summary, records: cuttingRows };
  }

  // Delivery: the shipments of the period, and for cut-to-ship the lifetime
  // cut and shipped totals of the orders they belong to. Cut is what the
  // cutting floor recorded when it recorded a count; otherwise the cut ledger.
  let delivery: ProductivityDto['delivery'] = null;
  if (shipments) {
    const orderIds = [...new Set(shipments.map((s) => s.orderId))];
    const [cutLedger, cutRecords, allShipped] = orderIds.length === 0 ? [[], [], []] : await Promise.all([
      prisma.stageQuantity.groupBy({
        by: ['orderId'], where: { orderId: { in: orderIds }, ledger: QtyLedger.CUT }, _sum: { qty: true },
      }),
      prisma.cuttingRecord.groupBy({
        by: ['orderId'], where: { orderId: { in: orderIds }, actualCutQty: { not: null } }, _sum: { actualCutQty: true },
      }),
      prisma.shipment.groupBy({
        by: ['orderId'], where: { orderId: { in: orderIds }, actualShippingDate: { not: null } }, _sum: { qty: true },
      }),
    ]);
    const ledgerCut = new Map(cutLedger.map((r) => [r.orderId, r._sum.qty ?? 0]));
    const recordedCut = new Map(cutRecords.map((r) => [r.orderId, r._sum.actualCutQty ?? 0]));
    const shipped = new Map(allShipped.map((r) => [r.orderId, r._sum.qty ?? 0]));
    const ledgers = orderIds.map((orderId) => {
      const recorded = recordedCut.get(orderId);
      const cutQty = recorded != null && recorded > 0 ? recorded : (ledgerCut.get(orderId) ?? null);
      return { orderId, cutQty, shippedQty: shipped.get(orderId) ?? null };
    });
    delivery = summariseDelivery(
      shipments.map((s) => ({
        id: s.id, orderId: s.orderId, qty: s.qty, actualShippingDate: s.actualShippingDate,
        // The shipment's own promise, else the order's. A shipment booked
        // without a date of its own is still promised by the order.
        promisedShippingDate: s.promisedShippingDate ?? s.order.promisedShippingDate,
      })),
      ledgers,
      range,
    );
  }

  const body: ProductivityDto = {
    range,
    previousRange: previous,
    overview,
    overviewTrend: compareTrend(overview.sewnPerRecordedDay, overviewBefore.sewnPerRecordedDay),
    labour,
    efficiencyTrend: compareTrend(labour.efficiencyPct, labourBefore.efficiencyPct),
    delivery,
    dayLogs: dayLogs.filter((l) => l.date >= current.start && l.date < current.end).map(toDayLogDto),
    primaryOperation: primary,
    output,
    trend: compareTrend(output.primaryAvgPerRecordedDay, before.primaryAvgPerRecordedDay),
    totalTrend: compareTrend(output.primaryQty, before.primaryQty),
    orders,
    records,
    quality,
    fabric,
  };
  res.json(body);
}));

/**
 * Record the factory's day: who was on the floor and for how long. One row
 * per calendar day, replaced in full on each save — the sheet for a day is
 * one thing, not a series of edits. Recording production is the permission
 * that fits: the same people, the same daily report.
 */
productivityRouter.put('/day-log/:date', requirePermission('production:write'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const date = dayKey.parse(req.params.date);
  const input = dayLogSchema.parse(req.body);
  const day = new Date(`${date}T00:00:00.000Z`);

  const data = {
    operators: input.operators, helpers: input.helpers, workingMinutes: input.workingMinutes,
    machinesRunning: input.machinesRunning, notes: input.notes ?? null, recordedById: actor.id,
  };
  const saved = await prisma.productionDayLog.upsert({
    where: { date: day },
    create: { date: day, ...data },
    update: data,
  });
  res.json(toDayLogDto(saved));
}));
