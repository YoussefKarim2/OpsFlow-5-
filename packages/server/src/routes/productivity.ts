/**
 * Factory productivity — Phase 1.
 *
 * A factory-wide view of what the existing records already say: daily output
 * by operation, the defect rate from quality audits, and fabric consumed per
 * piece from cutting records. It adds no tables and writes nothing. Every
 * figure is a sum of records somebody entered on an order, and a figure the
 * records cannot support is null with a stated reason — never an estimate.
 *
 * Cost, labour and efficiency are deliberately absent: the application holds
 * no daily cost or attendance, and the per-order costing sheet's daily cost is
 * a typed input on one order, not a fact about a day.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  ProductionOperation, computeAudit,
  isDayKey, daysInRange, previousRange, rangeBounds, compareTrend,
  summariseOutput, summariseByOrder, summariseDefectRate, summariseFabricUtilisation,
  PRIMARY_OPERATION, PRODUCTION_OPERATIONS,
  type ProductivityDto, type ProductivityRecordDto, type ProductivityOrderRowDto,
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
 * Which sections an account may see. Output needs production:read, which the
 * route already requires; the defect rate and fabric figures are quality and
 * cutting information and follow those permissions, the same as the tabs that
 * show the underlying records.
 */
export function sectionsFor(permissions: readonly string[]): { quality: boolean; fabric: boolean } {
  return {
    quality: permissions.includes('quality:read'),
    fabric: permissions.includes('cutting:read'),
  };
}

const dec = (v: Prisma.Decimal | null | undefined): number | null => (v == null ? null : Number(v.toString()));

const ORDER_REF = { select: {
  id: true, poNumber: true, orderName: true,
  client: { select: { name: true } }, factory: { select: { name: true } },
} } as const;

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

  const [production, audits, cutting] = await Promise.all([
    prisma.productionRecord.findMany({
      where: { date: { gte: span.start, lt: span.end } },
      include: { order: ORDER_REF },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
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
  ]);

  const inputs = production.map((p) => ({
    id: p.id, orderId: p.orderId, date: p.date, operation: p.operation, qty: p.qty, line: p.line, team: p.team,
  }));

  const output = summariseOutput(inputs, range, primary);
  const before = summariseOutput(inputs, previous, primary);

  const orderById = new Map(production.map((p) => [p.orderId, p.order]));
  const orders: ProductivityOrderRowDto[] = summariseByOrder(inputs, range, primary).map((row) => {
    const o = orderById.get(row.orderId)!;
    return {
      ...row,
      poNumber: o.poNumber, orderName: o.orderName,
      clientName: o.client.name, factoryName: o.factory?.name ?? null,
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
      };
    });
    const summary = summariseDefectRate(rows, range);
    const auditRows: ProductivityAuditRowDto[] = rows.map((r) => ({
      id: r.id, orderId: r.orderId, poNumber: r.order.poNumber, orderName: r.order.orderName,
      inspectionDate: r.inspectionDate.toISOString(), auditType: r.auditType,
      sampleSize: r.sampleSize, defectQty: r.defectQty, result: r.result,
      counted: r.sampleSize != null && r.sampleSize > 0 && r.defectQty != null,
    }));
    quality = { summary, audits: auditRows };
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

  const body: ProductivityDto = {
    range,
    previousRange: previous,
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
