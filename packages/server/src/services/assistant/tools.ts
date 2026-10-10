/**
 * The lookups Ask OpsFlow may make. All of them read; none of them writes.
 *
 * ANALYSIS.md §13: the assistant "must query through the same authorization
 * layer as a human user, not around it". So every tool takes the asker's
 * permissions and withholds what their role could not open on screen:
 *
 *   order:read      — required for every tool (the assistant is off without it)
 *   costing:read    — unit cost, total cost, profit and margin
 *   material:read   — shortages and stock
 *   external:read   — printing / embroidery sent out
 *   quality:read    — audits and their results
 *   shipment:read   — shipments, carriers, tracking
 *   production:read — daily rate, projected completion
 *   task:read       — the open tasks and who has them
 *
 * Stricter than some existing screens on purpose: material and outside-work
 * prices are not returned to anybody here, whatever their role, because none
 * of the assistant's questions needs them and the costing summary already
 * answers the money questions for the people allowed to ask them.
 *
 * Tool results go back to the model as JSON text. They are data — free text
 * typed by staff (task titles, notes) included — never instructions, and the
 * system prompt says so.
 */

import type { OrderSummaryDto } from '@opsflow/shared';
import type { OrderCandidate, OrderFacts, OrderSource } from './facts.js';
import { poKey } from './po-key.js';
import type { ToolSpec } from './providers.js';

export const ORDER_STATUSES = [
  'DRAFT', 'READY_FOR_PRODUCTION', 'IN_PRODUCTION', 'PRODUCTION_DELAYED', 'QUALITY_CHECK',
  'QUALITY_BLOCKED', 'PACKING', 'READY_TO_SHIP', 'SHIPPED', 'COMPLETED', 'CANCELLED',
];

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'get_order',
    description:
      'Everything about ONE order: status, health, current stage, progress, next action, blockers, alerts, open and overdue tasks, ' +
      'production pace, material shortages, outside work (printing/embroidery), quality audits, shipments and (if permitted) costing. ' +
      'Use this for any question about a specific order. Accepts a PO number in any format ("PO231", "13506", "A302059B") or the order name.',
    parameters: {
      type: 'object',
      properties: { order: { type: 'string', description: 'The PO number or order name as the person wrote it.' } },
      required: ['order'],
    },
  },
  {
    name: 'find_orders',
    description:
      'Search or list orders, one line each (status, stage, progress, dates, top blocker). Use for "which orders…", a customer\'s orders, ' +
      'orders in a status, or when get_order said a reference matched several orders.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Words to match in PO number, order name, style, customer, coordinator or factory. Optional.' },
        status: { type: 'string', description: 'Only orders in this status. Optional.', enum: ORDER_STATUSES },
        include_cancelled: { type: 'boolean', description: 'Include cancelled orders. Default false.' },
        limit: { type: 'integer', description: 'How many to return, 1-25. Default 10.' },
      },
    },
  },
  {
    name: 'orders_needing_attention',
    description:
      'The open orders most in need of attention right now, worst first: critical alerts, blockers, late or behind-schedule production, ' +
      'material shortages and ship dates closing in. Use for "what should I worry about", "what is late", "any problems today".',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'How many to return, 1-20. Default 8.' } },
    },
  },
];

export interface ToolContext {
  permissions: readonly string[];
  source: OrderSource;
  today: Date;
}

export interface ToolOutcome {
  /** JSON text for the model. */
  content: string;
  /** Orders the result is about, so the answer can link to them. */
  orders: Array<{ id: string; poNumber: string }>;
}

const can = (ctx: ToolContext, p: string) => ctx.permissions.includes(p);
const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** One order as a list line: the summary, with nothing a list does not need. */
export function summaryLine(s: OrderSummaryDto) {
  return {
    po: s.poNumber, name: s.orderName, customer: s.clientName, status: s.status, health: s.health,
    stage: s.currentStageLabel, progressPct: s.progressPct, orderQty: s.orderQty, producedQty: s.producedQty,
    shippedQty: s.shippedQty, requiredDelivery: s.requiredDeliveryDate?.slice(0, 10) ?? null,
    daysRemaining: s.daysRemaining, nextAction: s.nextAction, topBlocker: s.topBlocker,
    criticalAlerts: s.alertCounts.critical, materialShortCount: s.materialShortCount,
  };
}

/** Facts → what THIS person may be told. Sections their role cannot open are left out, and say so. */
export function redactFacts(f: OrderFacts, permissions: readonly string[]) {
  const has = (p: string) => permissions.includes(p);
  const hidden: string[] = [];
  const keep = <T>(perm: string, label: string, v: T): T | undefined => {
    if (has(perm)) return v;
    hidden.push(label);
    return undefined;
  };
  const s = f.summary;
  return {
    order: {
      po: s.poNumber, name: s.orderName, customer: s.clientName, season: s.season, style: s.styleNumber,
      item: s.itemType, fabric: s.fabric, coordinator: s.coordinatorName, factory: s.factoryName,
      priority: s.priority, cancelled: f.cancelled,
    },
    status: s.status,
    health: s.health,
    currentStage: s.currentStageLabel,
    progressPct: s.progressPct,
    nextAction: s.nextAction,
    nextActionDepartment: s.nextActionDepartment,
    quantities: { ordered: s.orderQty, produced: s.producedQty, packed: s.packedQty, shipped: s.shippedQty },
    dates: {
      poDate: s.poDate?.slice(0, 10) ?? null,
      promisedShipping: s.promisedShippingDate?.slice(0, 10) ?? null,
      requiredDelivery: s.requiredDeliveryDate?.slice(0, 10) ?? null,
      daysRemaining: s.daysRemaining,
    },
    stages: f.stages,
    blockers: f.blockers,
    warnings: f.warnings,
    alerts: f.alerts,
    production: keep('production:read', 'production pace', f.production),
    openTasks: keep('task:read', 'tasks', f.openTasks),
    materials: keep('material:read', 'materials and stock', f.materials),
    outsideWork: keep('external:read', 'outside work (printing/embroidery)', f.external),
    qualityAudits: keep('quality:read', 'quality audits', f.quality),
    shipments: keep('shipment:read', 'shipments', f.shipments),
    costing: keep('costing:read', 'costing and profit', f.costing),
    ...(hidden.length ? { notVisibleToThisUser: hidden } : {}),
  };
}

/** Pick the one order a reference means, or say it is ambiguous / unknown. */
export function resolveReference(text: string, candidates: OrderCandidate[]):
  | { kind: 'one'; order: OrderCandidate }
  | { kind: 'many'; options: OrderCandidate[] }
  | { kind: 'none' } {
  if (!candidates.length) return { kind: 'none' };
  const key = poKey(text);
  const exact = candidates.filter((c) => poKey(c.poNumber) === key);
  if (exact.length === 1) return { kind: 'one', order: exact[0]! };
  const byName = candidates.filter((c) => c.orderName.trim().toLowerCase() === text.trim().toLowerCase());
  if (byName.length === 1) return { kind: 'one', order: byName[0]! };
  if (candidates.length === 1) return { kind: 'one', order: candidates[0]! };
  return { kind: 'many', options: (exact.length > 1 ? exact : candidates).slice(0, 8) };
}

const out = (value: unknown, orders: ToolOutcome['orders'] = []): ToolOutcome => ({ content: JSON.stringify(value), orders });

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  if (!can(ctx, 'order:read')) return out({ error: 'This user may not read orders.' });

  if (name === 'get_order') {
    const ref = str(args.order, 80);
    if (!ref) return out({ error: 'Say which order: a PO number or order name.' });
    const match = resolveReference(ref, await ctx.source.findCandidates(ref, 12));
    if (match.kind === 'none') return out({ notFound: ref, hint: 'No order matches. Check the PO number, or search with find_orders.' });
    if (match.kind === 'many') {
      return out({
        ambiguous: ref,
        matches: match.options.map((c) => ({ po: c.poNumber, name: c.orderName, customer: c.clientName, cancelled: c.cancelled })),
        hint: 'Several orders match. Ask the person which one, listing these.',
      }, match.options.map((c) => ({ id: c.id, poNumber: c.poNumber })));
    }
    const facts = await ctx.source.loadFacts(match.order.id, ctx.today);
    if (!facts) return out({ notFound: ref });
    return out(redactFacts(facts, ctx.permissions), [{ id: match.order.id, poNumber: facts.summary.poNumber }]);
  }

  if (name === 'find_orders') {
    const status = str(args.status, 40).toUpperCase();
    const rows = await ctx.source.listSummaries({
      search: str(args.search, 80) || undefined,
      status: ORDER_STATUSES.includes(status) ? status : undefined,
      includeCancelled: args.include_cancelled === true || status === 'CANCELLED',
    }, clampInt(args.limit, 1, 25, 10), ctx.today);
    return out({ count: rows.length, orders: rows.map(summaryLine) }, rows.map((r) => ({ id: r.id, poNumber: r.poNumber })));
  }

  if (name === 'orders_needing_attention') {
    const limit = clampInt(args.limit, 1, 20, 8);
    const rows = (await ctx.source.openSummaries(ctx.today))
      .filter((s) => !['SHIPPED', 'COMPLETED', 'CANCELLED'].includes(s.status))
      .map((s) => ({ s, score: attentionScore(s) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.s.daysRemaining ?? 9999) - (b.s.daysRemaining ?? 9999))
      .slice(0, limit)
      .map((x) => x.s);
    return out({ count: rows.length, orders: rows.map(summaryLine) }, rows.map((r) => ({ id: r.id, poNumber: r.poNumber })));
  }

  return out({ error: `Unknown tool ${name}.` });
}

/** How urgently an open order needs a person. 0 = nothing to say. */
export function attentionScore(s: OrderSummaryDto): number {
  let score = s.alertCounts.critical * 100 + s.alertCounts.warning * 20 + s.alertCounts.attention * 5;
  score += s.blockerCount * 10 + s.materialShortCount * 8;
  if (s.health === 'LATE') score += 60;
  else if (s.health === 'ATTENTION') score += 25;
  if (s.status === 'PRODUCTION_DELAYED' || s.status === 'QUALITY_BLOCKED') score += 50;
  if (s.daysRemaining != null && s.daysRemaining < 0) score += 80;
  else if (s.daysRemaining != null && s.daysRemaining <= 7) score += 15;
  return score;
}
