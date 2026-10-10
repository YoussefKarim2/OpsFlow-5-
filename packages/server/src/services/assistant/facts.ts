/**
 * What Ask OpsFlow knows about an order, and where it gets it.
 *
 * Every figure here comes from `deriveOrder` / `buildOrderSummary`, the same
 * derivations the Order Workspace shows. The assistant never re-derives status,
 * progress or shortages on its own: if it did, it could disagree with the
 * screen, and a coordinator would rightly stop believing either.
 *
 * `OrderFacts` is everything about one order that a question might need,
 * unfiltered. Who may see which part is decided later, in tools.ts — keeping
 * the two apart is what lets the permission rules be tested without a
 * database.
 */

import { STAGE_META, TaskStatus, daysBetween, type OrderSummaryDto } from '@opsflow/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { ORDER_INCLUDE, buildOrderSummary, deriveOrder, listOrders, type FullOrder } from '../order-service.js';
import { poKey } from './po-key.js';

export interface OrderFacts {
  summary: OrderSummaryDto;
  cancelled: boolean;
  stages: Array<{ label: string; status: string; progressPct: number; overdueTasks: number; blockedTasks: number }>;
  alerts: Array<{ severity: string; title: string; detail: string; nextAction: string }>;
  blockers: Array<{ stage: string; requirement: string; detail: string }>;
  warnings: Array<{ stage: string; requirement: string; detail: string }>;
  production: {
    producedQty: number; remainingQty: number; producedPct: number | null;
    dailyRate: number | null; requiredDailyRate: number | null;
    projectedCompletion: string | null; slipDays: number | null; isBehindSchedule: boolean;
  };
  openTasks: Array<{ title: string; stage: string; department: string; assignee: string | null; dueDate: string | null; overdue: boolean; blockedReason: string | null }>;
  materials: { shortCount: number; fullySecured: boolean; shortages: Array<{ material: string; shortQty: number; requiredQty: number; unit: string }> } | null;
  external: Array<{ operation: string; qty: number; status: string; factory: string | null; sentDate: string | null; expectedReturnDate: string | null; actualReturnDate: string | null }>;
  quality: Array<{ type: string; date: string; result: string; rejectedQty: number | null; correctiveActionOpen: boolean }>;
  shipments: Array<{ status: string; qty: number; shippedOn: string | null; carrier: string | null; trackingNumber: string | null }>;
  costing: {
    totalCostUsd: number | null; unitCostUsd: number | null; sellPriceUsd: number | null;
    profitPerUnitUsd: number | null; profitPct: number | null; totalProfitUsd: number | null;
  };
}

/** A possible match for something a person typed ("PO231", "florida", "13506"). */
export interface OrderCandidate {
  id: string;
  poNumber: string;
  orderName: string;
  clientName: string;
  cancelled: boolean;
}

/** Where the tools read from. The real one is Prisma; tests pass a fake. */
export interface OrderSource {
  findCandidates(text: string, limit: number): Promise<OrderCandidate[]>;
  loadFacts(orderId: string, today: Date): Promise<OrderFacts | null>;
  listSummaries(filters: { search?: string; status?: string; includeCancelled?: boolean }, limit: number, today: Date): Promise<OrderSummaryDto[]>;
  /** Every order that is not cancelled, summarised. What the dashboard reads for its attention list. */
  openSummaries(today: Date): Promise<OrderSummaryDto[]>;
}

const day = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** The projection from a loaded order to what the assistant may be told. Pure. */
export function toFacts(order: FullOrder, today: Date): OrderFacts {
  const d = deriveOrder(order, today);
  const summary = buildOrderSummary(order, today, d);
  const openTasks = order.tasks
    .filter((t) => t.status !== TaskStatus.COMPLETED)
    .map((t) => {
      const gap = t.dueDate ? daysBetween(today, t.dueDate) : null;
      return {
        title: t.title,
        stage: STAGE_META[t.stageKey as keyof typeof STAGE_META]?.label ?? t.stageKey,
        department: t.department,
        assignee: t.assignee?.name ?? null,
        dueDate: day(t.dueDate),
        overdue: gap != null && gap < 0,
        blockedReason: t.blockedReason ?? null,
      };
    })
    // Overdue first, then by due date: the ones a person asks about.
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999')))
    .slice(0, 12);

  return {
    summary,
    cancelled: order.cancelled,
    stages: d.stages
      .filter((s) => s.totalTasks > 0)
      .map((s) => ({ label: s.label, status: s.status, progressPct: s.progressPct, overdueTasks: s.overdueTasks, blockedTasks: s.blockedTasks })),
    alerts: d.alerts.slice(0, 10).map((a) => ({ severity: a.severity, title: a.title, detail: a.detail, nextAction: a.nextAction })),
    blockers: d.blockers.slice(0, 10).map((b) => ({ stage: b.stageLabel, requirement: b.requirement, detail: b.detail })),
    warnings: d.warnings.slice(0, 6).map((b) => ({ stage: b.stageLabel, requirement: b.requirement, detail: b.detail })),
    production: {
      producedQty: d.producedQty,
      remainingQty: d.production.remainingQty,
      producedPct: d.production.producedPct,
      dailyRate: d.production.dailyRate,
      requiredDailyRate: d.production.requiredDailyRate,
      projectedCompletion: day(d.production.projectedCompletion),
      slipDays: d.production.slipDays,
      isBehindSchedule: d.production.isBehindSchedule,
    },
    openTasks,
    materials: d.materials
      ? {
          shortCount: d.materials.shortCount,
          fullySecured: d.materials.fullySecured,
          shortages: d.materials.topShortages.slice(0, 8).map((r) => ({ material: r.materialName, shortQty: r.shortQty, requiredQty: r.requiredQty, unit: r.unit })),
        }
      : null,
    external: order.externalOperations.map((e) => ({
      operation: e.operationType,
      qty: e.qty,
      status: e.status,
      factory: e.externalFactory?.name ?? null,
      sentDate: day(e.sentDate),
      expectedReturnDate: day(e.expectedReturnDate),
      actualReturnDate: day(e.actualReturnDate),
    })),
    quality: order.qualityAudits
      .slice()
      .sort((a, b) => b.inspectionDate.getTime() - a.inspectionDate.getTime())
      .slice(0, 6)
      .map((q) => ({
        type: q.auditType,
        date: day(q.inspectionDate) ?? '',
        result: q.result,
        rejectedQty: q.rejectedQty ?? null,
        correctiveActionOpen: q.result === 'FAIL' && !q.correctiveActionClosed,
      })),
    shipments: order.shipments.map((s) => ({
      status: s.status, qty: s.qty, shippedOn: day(s.actualShippingDate), carrier: s.carrier ?? null, trackingNumber: s.trackingNumber ?? null,
    })),
    costing: {
      totalCostUsd: d.costing.totalCostUsd,
      unitCostUsd: d.costing.unitActualCostUsd,
      sellPriceUsd: d.costing.sellPriceUsd,
      profitPerUnitUsd: d.costing.profitPerUnitUsd,
      profitPct: d.costing.profitPct,
      totalProfitUsd: d.costing.totalProfitUsd,
    },
  };
}

export const prismaOrderSource: OrderSource = {
  async findCandidates(text, limit) {
    const raw = text.trim().slice(0, 80);
    const key = poKey(raw);
    if (!raw) return [];
    const select = { id: true, poNumber: true, orderName: true, cancelled: true, client: { select: { name: true } } } as const;
    const toCandidate = (r: { id: string; poNumber: string; orderName: string; cancelled: boolean; client: { name: string } }) =>
      ({ id: r.id, poNumber: r.poNumber, orderName: r.orderName, clientName: r.client.name, cancelled: r.cancelled });

    // The PO itself first, in the spellings people use for it. A short
    // reference ("231", "T1") can match dozens of orders by name or customer,
    // and the one it actually names must not fall outside the fuzzy results.
    const spellings = [...new Set([raw, key, `PO${key}`, `PO-${key}`, `PO ${key}`].filter(Boolean))];
    const exact = await prisma.order.findMany({
      where: { OR: spellings.map((p) => ({ poNumber: { equals: p, mode: 'insensitive' as const } })) },
      select,
      take: limit,
    });

    const or: Prisma.OrderWhereInput[] = [
      { poNumber: { contains: raw, mode: 'insensitive' } },
      { orderName: { contains: raw, mode: 'insensitive' } },
      { styleNumber: { contains: raw, mode: 'insensitive' } },
      { externalReference: { contains: raw, mode: 'insensitive' } },
      { client: { name: { contains: raw, mode: 'insensitive' } } },
    ];
    if (key && key !== raw.toUpperCase()) or.push({ poNumber: { contains: key, mode: 'insensitive' } });
    const fuzzy = await prisma.order.findMany({
      where: { OR: or, id: { notIn: exact.map((e) => e.id) } },
      select,
      orderBy: [{ cancelled: 'asc' }, { requiredDeliveryDate: 'asc' }],
      take: Math.max(0, limit - exact.length),
    });
    return [...exact, ...fuzzy].map(toCandidate);
  },
  async loadFacts(orderId, today) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    return order ? toFacts(order, today) : null;
  },
  async listSummaries(filters, limit, today) {
    const { data } = await listOrders(filters, 1, limit, today);
    return data;
  },
  async openSummaries(today) {
    // The same load the dashboard makes on every visit (routes/dashboard.ts):
    // every non-cancelled order. Status is derived, so closed ones are
    // filtered out after, by the caller.
    const rows = await prisma.order.findMany({ where: { cancelled: false }, include: ORDER_INCLUDE });
    return rows.map((o) => buildOrderSummary(o, today));
  },
};
