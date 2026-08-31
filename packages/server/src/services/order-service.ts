/**
 * Order assembly.
 *
 * This is the single place where an order is loaded and its derived state
 * computed. Every read path — the dashboard, the orders list, the workspace —
 * goes through `buildOrderDetail` or `buildOrderSummary`, so the progress shown
 * on a list row and the progress shown on the order page are produced by the
 * same code. In the workbook they were produced by different formulas on
 * different sheets, which is why they disagreed.
 */

import type { Prisma } from '@prisma/client';
import {
  QtyLedger, StageKey, STAGE_META, DEPARTMENT_LABEL, ORDER_STATUS_LABEL,
  computeStageProgress, computeOrderProgress, currentStage, deriveOrderStatus,
  deriveHealth, deriveNextAction, evaluateAlerts, countBySeverity,
  computeFunnel, computeColorProgress, computeCutVariance, computeStockDeduction,
  computeProductionAnalytics, computeBomSummary, computeCosting, computeQualityPassPct,
  computeMaterialPosition, computeStockPosition, computeConsumptionVariance,
  computeMarkerPlan, evaluateAllGates,
  ledgerTotals, buildMatrix, daysBetween, sum, qtyAdd, qtySub,
  type QtyCell, type AxisRef, type TaskLike, type OrderDetailDto, type OrderSummaryDto,
  type TaskDto, type BomItemInput, type CostLineInput, type ProductionEntry, type Alert,
  type RequirementInput, type MaterialPosition, type ConsumptionVariance,
  type Blocker, type GateContext,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { NotFoundError } from '../errors.js';

/** Everything needed to compute an order's derived state, in one query. */
const ORDER_INCLUDE = {
  client: true,
  factory: true,
  externalFactory: true,
  coordinator: { include: { role: true } },
  outsideWorkManager: { include: { role: true } },
  colors: { include: { color: true }, orderBy: { position: 'asc' } },
  sizes: { include: { size: true }, orderBy: { position: 'asc' } },
  quantities: true,
  notes: true,
  stages: true,
  tasks: {
    include: { assignee: true, completedBy: true, _count: { select: { comments: true, attachments: true } } },
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
  },
  // The material graph is selected, not included wholesale: a BOM line needs
  // its material's stock and that material's reservations *across all orders*
  // to know what is genuinely available, and nothing else.
  bomItems: {
    include: {
      color: true,
      material: {
        select: {
          id: true, name: true, unit: true, minimumQty: true,
          stock: { select: { physicalQty: true } },
          reservations: {
            where: { status: 'ACTIVE' as const },
            select: { id: true, orderId: true, qty: true, consumedQty: true },
          },
        },
      },
      reservations: {
        where: { status: 'ACTIVE' as const },
        select: { id: true, qty: true, consumedQty: true },
      },
    },
    orderBy: { position_: 'asc' },
  },
  materialMovements: {
    where: { type: { in: ['ISSUE', 'RETURN'] as const } },
    select: { materialId: true, type: true, qty: true },
  },
  externalOperations: { include: { externalFactory: true, approval: true } },
  approvals: { include: { requestedBy: true, _count: { select: { attachments: true } } } },
  productionRecords: { orderBy: { date: 'asc' } },
  qualityAudits: { include: { defects: true } },
  packingLists: { include: { cartons: true } },
  shipments: true,
  costing: { include: { lines: { orderBy: { position: 'asc' } } } },
  markers: { orderBy: { position: 'asc' } },
  cuttingRecords: true,
  fabricRecords: true,
  _count: { select: { attachments: true } },
} satisfies Prisma.OrderInclude;

type FullOrder = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

const dec = (v: Prisma.Decimal | null | undefined): number | null =>
  v == null ? null : Number(v.toString());

const iso = (d: Date | null | undefined): string | null => d?.toISOString() ?? null;

// ─────────────────────────────────────────────────────────────────────────────
// Projection helpers — turn Prisma rows into the shapes @opsflow/shared expects.
// ─────────────────────────────────────────────────────────────────────────────

function toAxes(order: FullOrder): { colors: AxisRef[]; sizes: AxisRef[] } {
  return {
    colors: order.colors.map((c) => ({ id: c.id, name: c.color.name, position: c.position })),
    sizes: order.sizes.map((s) => ({ id: s.id, name: s.size.name, position: s.position })),
  };
}

function toQtyCells(order: FullOrder): QtyCell[] {
  return order.quantities.map((q) => ({
    colorId: q.orderColorId,
    sizeId: q.orderSizeId,
    ledger: q.ledger as QtyLedger,
    qty: q.qty,
  }));
}

function toTaskLikes(order: FullOrder): TaskLike[] {
  return order.tasks.map((t) => ({
    id: t.id,
    stageKey: t.stageKey as StageKey,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    completedAt: t.completedAt,
    assigneeName: t.assignee?.name ?? null,
    department: DEPARTMENT_LABEL[t.department].en,
    sequence: t.sequence,
  }));
}

function toBomInputs(order: FullOrder): BomItemInput[] {
  return order.bomItems.map((b) => ({
    id: b.id,
    category: b.category,
    position: b.position,
    item: b.item,
    description: b.description,
    color: b.color?.name ?? b.colorText ?? null,
    unit: b.unit,
    consumptionPerPiece: dec(b.consumptionPerPiece),
    requiredQty: Number(b.requiredQty.toString()),
    issuedQty: Number(b.issuedQty.toString()),
  }));
}

/**
 * Turn the BOM into requirements the inventory engine can check.
 *
 * The available figure comes from the *material's* whole position — its stock
 * everywhere, less every order's reservations — not from this order's slice.
 * Availability is a property of the shelf, not of the order looking at it.
 */
function toRequirementInputs(order: FullOrder): RequirementInput[] {
  return order.bomItems.map((b) => {
    const reservedQty = sum(
      b.reservations.map((r) => Math.max(0, qtySub(Number(r.qty.toString()), Number(r.consumedQty.toString())))),
    );

    let availableQty: number | null = null;
    if (b.material) {
      const physical = sum(b.material.stock.map((s) => Number(s.physicalQty.toString())));
      availableQty = computeStockPosition({
        physicalQty: physical,
        reservations: b.material.reservations.map((r) => ({
          id: r.id,
          orderId: r.orderId,
          qty: Number(r.qty.toString()),
          consumedQty: Number(r.consumedQty.toString()),
          active: true,
        })),
        minimumQty: dec(b.material.minimumQty),
      }).availableQty;
    }

    return {
      id: b.id,
      materialId: b.materialId,
      materialName: b.material?.name ?? b.item,
      unit: b.unit,
      requiredQty: Number(b.requiredQty.toString()),
      reservedQty,
      issuedQty: Number(b.issuedQty.toString()),
      availableQty,
    };
  });
}

/**
 * Expected against actual consumption, per material.
 *
 * Expected comes from the BOM's consumption-per-piece times what the line has
 * actually produced; actual comes from the movement ledger, net of returns.
 * A material with no consumption rate is skipped rather than reported as zero.
 */
function toConsumptionVariances(order: FullOrder, producedQty: number): ConsumptionVariance[] {
  const actualByMaterial = new Map<string, number>();
  for (const m of order.materialMovements) {
    if (!m.materialId) continue;
    const qty = Number(m.qty.toString());
    actualByMaterial.set(
      m.materialId,
      qtyAdd(actualByMaterial.get(m.materialId) ?? 0, m.type === 'RETURN' ? -qty : qty),
    );
  }

  const out: ConsumptionVariance[] = [];
  for (const b of order.bomItems) {
    const rate = dec(b.consumptionPerPiece);
    if (!b.materialId || rate == null || rate <= 0) continue;
    out.push(
      computeConsumptionVariance({
        materialName: b.material?.name ?? b.item,
        unit: b.unit,
        consumptionPerPiece: rate,
        piecesProduced: producedQty,
        actualQty: actualByMaterial.get(b.materialId) ?? 0,
      }),
    );
  }
  return out;
}

function toProductionEntries(order: FullOrder): ProductionEntry[] {
  return order.productionRecords.map((p) => ({
    date: p.date, operation: p.operation, qty: p.qty, line: p.line, team: p.team,
  }));
}

export function toTaskDto(
  t: FullOrder['tasks'][number],
  order: { id: string; poNumber: string; orderName: string },
  today = new Date(),
): TaskDto {
  const daysRemaining = t.dueDate ? daysBetween(today, t.dueDate) : null;
  return {
    id: t.id,
    orderId: order.id,
    orderPoNumber: order.poNumber,
    orderName: order.orderName,
    stageKey: t.stageKey as StageKey,
    stageLabel: STAGE_META[t.stageKey as StageKey].label,
    title: t.title,
    requirementEn: t.requirementEn,
    requirementAr: t.requirementAr,
    department: t.department,
    departmentLabel: DEPARTMENT_LABEL[t.department].en,
    assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name } : null,
    status: t.status,
    priority: t.priority,
    sequence: t.sequence,
    estimatedMinutes: t.estimatedMinutes,
    dueDate: iso(t.dueDate),
    startedAt: iso(t.startedAt),
    completedAt: iso(t.completedAt),
    completedBy: t.completedBy ? { id: t.completedBy.id, name: t.completedBy.name } : null,
    notes: t.notes,
    attachmentCount: t._count.attachments,
    commentCount: t._count.comments,
    daysRemaining,
    isOverdue: t.status !== 'COMPLETED' && daysRemaining != null && daysRemaining < 0,
    blockedReason: t.blockedReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The core: compute everything derived about an order, once.
// ─────────────────────────────────────────────────────────────────────────────

export interface DerivedOrder {
  cells: QtyCell[];
  colors: AxisRef[];
  sizes: AxisRef[];
  totals: Record<QtyLedger, number>;
  stages: ReturnType<typeof computeStageProgress>;
  progressPct: number;
  currentStageKey: StageKey | null;
  status: ReturnType<typeof deriveOrderStatus>;
  health: ReturnType<typeof deriveHealth>;
  nextAction: ReturnType<typeof deriveNextAction>;
  alerts: Alert[];
  production: ReturnType<typeof computeProductionAnalytics>;
  bom: ReturnType<typeof computeBomSummary> | null;
  materials: MaterialPosition | null;
  blockers: Blocker[];
  warnings: Blocker[];
  readyStages: StageKey[];
  /** The lay plan, when there are markers. Null when nobody has planned one. */
  markerPlan: ReturnType<typeof computeMarkerPlan> | null;
  consumption: ConsumptionVariance[];
  costing: ReturnType<typeof computeCosting> | null;
  daysRemaining: number | null;
}

export function deriveOrder(order: FullOrder, today = new Date()): DerivedOrder {
  const { colors, sizes } = toAxes(order);
  const cells = toQtyCells(order);
  const totals = ledgerTotals(cells);
  const tasks = toTaskLikes(order);

  const stages = computeStageProgress(tasks, today);
  const progressPct = computeOrderProgress(stages);
  const stage = currentStage(stages);

  const bom = order.bomItems.length > 0 ? computeBomSummary(toBomInputs(order)) : null;

  // What the order needs measured against what is actually on the shelf, as
  // opposed to `bom`, which only knows what has been issued against it.
  const materials = order.bomItems.length > 0 ? computeMaterialPosition(toRequirementInputs(order)) : null;

  const production = computeProductionAnalytics({
    entries: toProductionEntries(order),
    orderQty: totals[QtyLedger.ORDER] ?? 0,
    cutQty: totals[QtyLedger.CUT] ?? 0,
    requiredDate: order.requiredDeliveryDate,
    today,
  });

  // The IN_LINE ledger and the sewing production records are two views of the
  // same reality, recorded by different people. Take whichever is further along
  // rather than letting one department's lag understate the order.
  const producedQty = Math.max(totals[QtyLedger.IN_LINE] ?? 0, production.producedQty);
  const packedQty = totals[QtyLedger.PACKED] ?? 0;
  const shippedQty = totals[QtyLedger.SHIPPED] ?? 0;

  const openQualityFailure = order.qualityAudits.some(
    (a) => a.result === 'FAIL' && !a.correctiveActionClosed,
  );
  const pendingBlockingApproval = order.approvals.some(
    (a) => a.status === 'PENDING' && a.blocking,
  );
  const latestPackingList = order.packingLists.at(-1) ?? null;
  const latestShipment = order.shipments.at(-1) ?? null;

  const status = deriveOrderStatus({
    cancelled: order.cancelled,
    hasOpenQualityFailure: openQualityFailure,
    shipmentStatus: latestShipment?.status ?? null,
    orderQty: totals[QtyLedger.ORDER] ?? 0,
    producedQty,
    packedQty,
    shippedQty,
    qualityPassedQty: totals[QtyLedger.OUT_LINE] ?? 0,
    packingApproved: latestPackingList?.approved ?? false,
    materialsFullyIssued: bom?.fullyIssued ?? false,
    hasPendingBlockingApproval: pendingBlockingApproval,
    isBehindSchedule: production.isBehindSchedule,
    anyTaskStarted: order.tasks.some((t) => t.status !== 'NOT_STARTED'),
  });

  // ── Stage gates ─────────────────────────────────────────────────────────
  //
  // Every blocker on every screen is computed here, on the request that renders
  // it. Nothing is stored, so a shortage resolved this morning cannot still be
  // shown this afternoon.
  const markerPlan = order.markers.length > 0
    ? computeMarkerPlan(
        order.markers.map((m) => ({
          id: m.id,
          fabric: m.fabricName,
          color: m.fabricColor ?? '',
          panel: m.panel,
          ratio: m.sizeRatio,
          layers: m.layers,
          markerLengthM: Number(m.markerLengthM.toString()),
          totalLengthM: dec(m.totalLengthM),
          nestPcs: m.nestPcs,
        })),
        Object.fromEntries(
          order.sizes.map((s) => [
            s.size.name,
            cells.filter((c) => c.sizeId === s.id && c.ledger === QtyLedger.CUT).reduce((a, c) => a + c.qty, 0),
          ]),
        ),
      )
    : null;

  const completedStages = new Set(
    stages.filter((s) => s.status === 'COMPLETED').map((s) => s.stageKey),
  );

  const blockingApproval = order.approvals.find((a) => a.status === 'PENDING' && a.blocking);
  const worstShortage = materials?.topShortages[0] ?? null;

  const gateContext: GateContext = {
    orderQty: totals[QtyLedger.ORDER] ?? 0,
    cutQty: totals[QtyLedger.CUT] ?? 0,
    producedQty,
    packedQty,
    quantityCellCount: cells.filter((c) => c.ledger === QtyLedger.ORDER && c.qty > 0).length,
    hasBom: order.bomItems.length > 0,
    bomFullyIssued: bom?.fullyIssued ?? false,
    materialsFullyCoverable: materials?.fullyCoverable ?? true,
    materialShortageCount: materials?.shortCount ?? 0,
    materialShortageDetail: worstShortage
      ? `${worstShortage.materialName} is short by ${worstShortage.shortQty.toLocaleString()} ${worstShortage.unit}` +
        ((materials?.shortCount ?? 0) > 1 ? `, and ${(materials!.shortCount - 1)} other material${materials!.shortCount === 2 ? '' : 's'} are short too.` : '.')
      : null,
    hasMarkers: order.markers.length > 0,
    markerCoversRequirement: markerPlan ? markerPlan.varianceTotal >= 0 : false,
    markerShortfall: markerPlan?.varianceTotal ?? 0,
    hasPendingBlockingApproval: !!blockingApproval,
    pendingApprovalLabel: blockingApproval
      ? `${blockingApproval.type.replace(/_/g, ' ').toLowerCase()} approval`
      : null,
    externalOpsBlocked: order.externalOperations.filter(
      (op) => op.requiresApproval && op.approval?.status !== 'APPROVED' && op.status !== 'RETURNED',
    ).length,
    hasOpenQualityFailure: openQualityFailure,
    qualityInspected: order.qualityAudits.some((a) => a.result !== 'PENDING'),
    packingApproved: latestPackingList?.approved ?? false,
    hasCartons: order.packingLists.some((p) => p.cartons.length > 0),
    completedStages,
  };

  const gates = evaluateAllGates(
    gateContext,
    Object.fromEntries(Object.entries(STAGE_META).map(([k, v]) => [k, v.label])) as Partial<Record<StageKey, string>>,
  );

  const consumption = toConsumptionVariances(order, producedQty);

  const alerts = evaluateAlerts({
    today,
    order: {
      poNumber: order.poNumber,
      requiredDeliveryDate: order.requiredDeliveryDate,
      promisedShippingDate: order.promisedShippingDate,
      orderQty: totals[QtyLedger.ORDER] ?? 0,
      packedQty,
      producedQty,
    },
    tasks,
    bom,
    materials,
    blockers: gates.blockers,
    consumption,
    production,
    approvals: order.approvals.map((a) => ({
      id: a.id, type: a.type, status: a.status, blocking: a.blocking, requestedDate: a.requestedDate,
    })),
    externalOps: order.externalOperations.map((op) => ({
      id: op.id,
      operationType: op.operationType,
      status: op.status,
      requiresApproval: op.requiresApproval,
      approvalCleared: op.approval?.status === 'APPROVED',
      expectedReturnDate: op.expectedReturnDate,
      actualReturnDate: op.actualReturnDate,
    })),
    quality: order.qualityAudits.map((a) => ({
      id: a.id,
      result: a.result as 'PASS' | 'FAIL' | 'PENDING',
      correctiveActionClosed: a.correctiveActionClosed,
    })),
  });

  const counts = countBySeverity(alerts);
  const daysRemaining = order.requiredDeliveryDate
    ? daysBetween(today, order.requiredDeliveryDate)
    : null;

  const health = deriveHealth({
    status,
    daysRemaining,
    isBehindSchedule: production.isBehindSchedule,
    criticalAlerts: counts.CRITICAL,
    warningAlerts: counts.WARNING,
    progressPct,
  });

  const costing = order.costing
    ? computeCosting({
        orderQty: totals[QtyLedger.ORDER] ?? 0,
        cutQty: totals[QtyLedger.CUT] ?? 0,
        shippedQty: shippedQty > 0 ? shippedQty : null,
        dollarRate: Number(order.costing.dollarRate.toString()),
        dailyCostEgp: dec(order.costing.dailyCostEgp),
        machineCount: order.costing.machineCount,
        machineDaysUsed: order.costing.machineDaysUsed,
        daysInLine: order.costing.daysInLine,
        sellPriceUsd: dec(order.pricePerPieceUsd),
        externalOpCostUsd: dec(order.costing.externalOpCostUsd),
        sublimationCostUsd: dec(order.costing.sublimationCostUsd),
        embroideryCostUsd: dec(order.costing.embroideryCostUsd),
        lines: order.costing.lines.map<CostLineInput>((l) => ({
          group: l.group,
          label: l.label,
          quantity: dec(l.quantity),
          unit: l.unit,
          unitPriceUsd: dec(l.unitPriceUsd),
        })),
      })
    : null;

  return {
    cells, colors, sizes, totals, stages, progressPct,
    currentStageKey: stage?.stageKey ?? null,
    status, health,
    nextAction: deriveNextAction(stages),
    alerts, production, bom, costing, daysRemaining,
    materials,
    blockers: gates.blockers,
    warnings: gates.warnings,
    readyStages: gates.readyStages,
    markerPlan,
    consumption,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function getOrderDetail(orderId: string, today = new Date()): Promise<OrderDetailDto> {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: orderId }, { poNumber: orderId }] },
    include: ORDER_INCLUDE,
  });
  if (!order) throw new NotFoundError('Order');

  const d = deriveOrder(order, today);
  const noteOf = (kind: string) => order.notes.find((n) => n.kind === kind)?.body ?? null;
  const cutPct = Number(order.cutPercentage.toString());

  return {
    id: order.id,
    poNumber: order.poNumber,
    orderName: order.orderName,
    season: order.season,
    itemType: order.itemType,
    gender: order.gender,
    styleNumber: order.styleNumber,
    fit: order.fit,
    blockPattern: order.blockPattern,
    fabric: order.fabric,
    shippingMethod: order.shippingMethod,
    pricePerPieceUsd: dec(order.pricePerPieceUsd),
    cutPercentage: cutPct,
    accessoryPercentage: Number(order.accessoryPercentage.toString()),
    externalReference: order.externalReference,
    externalWorkSort: order.externalWorkSort,
    externalWorkType: order.externalWorkType,
    poDate: iso(order.poDate),
    promisedShippingDate: iso(order.promisedShippingDate),
    requiredDeliveryDate: iso(order.requiredDeliveryDate),
    cancelled: order.cancelled,
    priority: order.priority,

    client: {
      id: order.client.id, name: order.client.name, code: order.client.code,
      shippingAddress: order.shippingAddress ?? order.client.shippingAddress,
      billingAddress: order.billingAddress ?? order.client.billingAddress,
    },
    factory: order.factory
      ? { id: order.factory.id, name: order.factory.name, code: order.factory.code, address: order.factory.address, isExternal: order.factory.isExternal }
      : null,
    externalFactory: order.externalFactory
      ? { id: order.externalFactory.id, name: order.externalFactory.name, code: order.externalFactory.code, address: order.externalFactory.address, isExternal: true }
      : null,
    coordinator: order.coordinator ? userDto(order.coordinator) : null,
    outsideWorkManager: order.outsideWorkManager ? userDto(order.outsideWorkManager) : null,

    notes: {
      general: noteOf('GENERAL'),
      spread: noteOf('SPREAD'),
      cut: noteOf('CUT'),
      packing: noteOf('PACKING'),
      external: noteOf('EXTERNAL'),
    },

    status: d.status,
    health: d.health,
    progressPct: d.progressPct,
    currentStage: d.currentStageKey,
    nextAction: d.nextAction,
    stages: d.stages,
    alerts: d.alerts,
    funnel: computeFunnel(d.cells),
    colorProgress: computeColorProgress(d.cells, d.colors),
    cutVariance: computeCutVariance(
      d.cells, cutPct,
      order.cuttingRecords.at(-1)?.actualCutQty ?? null,
    ),
    stockDeduction: computeStockDeduction(d.cells, cutPct),
    production: d.production,
    bom: d.bom,
    materials: d.materials,
    blockers: d.blockers,
    warnings: d.warnings,
    readyStages: d.readyStages,
    consumption: d.consumption,
    costing: d.costing,
    qualityPassPct: computeQualityPassPct(d.cells),

    counts: {
      openTasks: order.tasks.filter((t) => t.status !== 'COMPLETED').length,
      overdueTasks: d.stages.reduce((a, s) => a + s.overdueTasks, 0),
      pendingApprovals: order.approvals.filter((a) => a.status === 'PENDING').length,
      openExternalOps: order.externalOperations.filter((o) => o.status !== 'RETURNED' && o.status !== 'CANCELLED').length,
      attachments: order._count.attachments,
      blockers: d.blockers.length,
    },
    updatedAt: order.updatedAt.toISOString(),
  };
}

function userDto(u: { id: string; name: string; email: string; department: string; role: { key: string; label: string; permissions: string[] } }) {
  return {
    id: u.id, name: u.name, email: u.email,
    roleKey: u.role.key, roleLabel: u.role.label,
    department: u.department as never,
    permissions: u.role.permissions,
    avatarInitials: u.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase(),
  };
}

export function buildOrderSummary(order: FullOrder, today = new Date()): OrderSummaryDto {
  const d = deriveOrder(order, today);
  const counts = countBySeverity(d.alerts);
  return {
    id: order.id,
    poNumber: order.poNumber,
    orderName: order.orderName,
    clientName: order.client.name,
    season: order.season,
    coordinatorName: order.coordinator?.name ?? null,
    factoryName: order.factory?.name ?? null,
    itemType: order.itemType,
    styleNumber: order.styleNumber,
    fabric: order.fabric,
    shippingMethod: order.shippingMethod,
    orderQty: d.totals[QtyLedger.ORDER] ?? 0,
    producedQty: Math.max(d.totals[QtyLedger.IN_LINE] ?? 0, d.production.producedQty),
    packedQty: d.totals[QtyLedger.PACKED] ?? 0,
    shippedQty: d.totals[QtyLedger.SHIPPED] ?? 0,
    currentStage: d.currentStageKey,
    currentStageLabel: d.currentStageKey ? STAGE_META[d.currentStageKey].label : null,
    progressPct: d.progressPct,
    status: d.status,
    health: d.health,
    priority: order.priority,
    poDate: iso(order.poDate),
    promisedShippingDate: iso(order.promisedShippingDate),
    requiredDeliveryDate: iso(order.requiredDeliveryDate),
    daysRemaining: d.daysRemaining,
    nextAction: d.nextAction.text,
    nextActionDepartment: d.nextAction.department,
    alertCounts: { critical: counts.CRITICAL, warning: counts.WARNING, attention: counts.ATTENTION },
    blockerCount: d.blockers.length,
    // The single most pressing reason this order is stuck, so a list row can
    // say why without the coordinator having to open it.
    topBlocker: d.blockers[0] ? `${d.blockers[0].stageLabel}: ${d.blockers[0].requirement}` : null,
    materialShortCount: d.materials?.shortCount ?? 0,
    updatedAt: order.updatedAt.toISOString(),
  };
}

export interface OrderFilters {
  search?: string;
  clientId?: string;
  coordinatorId?: string;
  season?: string;
  status?: string;
  stage?: string;
  factoryId?: string;
  shippingMethod?: string;
  priority?: string;
  dueBefore?: string;
  dueAfter?: string;
  includeCancelled?: boolean;
}

export async function listOrders(
  filters: OrderFilters,
  page = 1,
  pageSize = 25,
  today = new Date(),
): Promise<{ data: OrderSummaryDto[]; total: number }> {
  const where: Prisma.OrderWhereInput = {};

  if (!filters.includeCancelled) where.cancelled = false;
  if (filters.clientId) where.clientId = filters.clientId;
  if (filters.coordinatorId) where.coordinatorId = filters.coordinatorId;
  if (filters.season) where.season = filters.season;
  if (filters.factoryId) {
    where.OR = [{ factoryId: filters.factoryId }, { externalFactoryId: filters.factoryId }];
  }
  if (filters.shippingMethod) where.shippingMethod = filters.shippingMethod;
  if (filters.priority) where.priority = filters.priority as Prisma.EnumPriorityFilter['equals'];
  if (filters.dueBefore || filters.dueAfter) {
    where.requiredDeliveryDate = {
      ...(filters.dueBefore ? { lte: new Date(filters.dueBefore) } : {}),
      ...(filters.dueAfter ? { gte: new Date(filters.dueAfter) } : {}),
    };
  }
  if (filters.search) {
    const q = filters.search.trim();
    where.AND = [
      {
        OR: [
          { poNumber: { contains: q, mode: 'insensitive' } },
          { orderName: { contains: q, mode: 'insensitive' } },
          { styleNumber: { contains: q, mode: 'insensitive' } },
          { externalReference: { contains: q, mode: 'insensitive' } },
          { client: { name: { contains: q, mode: 'insensitive' } } },
          { coordinator: { name: { contains: q, mode: 'insensitive' } } },
          { factory: { name: { contains: q, mode: 'insensitive' } } },
        ],
      },
    ];
  }

  // Status and stage are DERIVED, so they cannot be filtered in SQL. The rows
  // are fetched and filtered in memory after derivation. At this scale (an
  // order book in the hundreds) that is correct and simple; if it stops being
  // so, the escape hatch is the cachedStatus column, already on the model.
  const needsDerivedFilter = Boolean(filters.status || filters.stage);

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: [{ requiredDeliveryDate: 'asc' }, { createdAt: 'desc' }],
      ...(needsDerivedFilter ? {} : { skip: (page - 1) * pageSize, take: pageSize }),
    }),
    prisma.order.count({ where }),
  ]);

  let summaries = rows.map((o) => buildOrderSummary(o, today));

  if (filters.status) summaries = summaries.filter((s) => s.status === filters.status);
  if (filters.stage) summaries = summaries.filter((s) => s.currentStage === filters.stage);

  if (needsDerivedFilter) {
    const filteredTotal = summaries.length;
    return {
      data: summaries.slice((page - 1) * pageSize, page * pageSize),
      total: filteredTotal,
    };
  }

  return { data: summaries, total };
}

/** Refresh the advisory cache columns. Called after writes; never read as truth. */
export async function refreshOrderCache(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  if (!order) return;
  const d = deriveOrder(order);
  await prisma.order.update({
    where: { id: orderId },
    data: {
      cachedProgressPct: d.progressPct,
      cachedStatus: d.status,
      cachedStageKey: d.currentStageKey,
    },
  });
}

export { ORDER_INCLUDE, type FullOrder, toQtyCells, toAxes, buildMatrix };
