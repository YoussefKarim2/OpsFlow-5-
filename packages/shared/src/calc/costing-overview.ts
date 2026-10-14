/**
 * The costing of every order at a glance — what the Costing entry in the
 * sidebar shows before anyone opens an order.
 *
 * Each row is one order's costing as the engine computes it on that order's
 * own screen (`computeCosting`), so the two can never disagree. The totals are
 * over the orders whose figures exist: an order still waiting for a price or
 * a shipment contributes nothing and is counted as waiting, never as zero.
 */

import { safeDiv, safePct, sum } from './num.js';

export interface CostingOverviewRow {
  orderId: string;
  poNumber: string;
  orderName: string;
  clientName: string;
  status: string;
  orderQty: number;
  shippedQty: number | null;
  /** True when a costing record has been saved on the order. */
  hasRecord: boolean;
  costingDate: string | null;
  sellPriceUsd: number | null;
  fabricCostUsd: number | null;
  accessoryCostUsd: number | null;
  externalCostUsd: number | null;
  cmCostUsd: number | null;
  otherCostUsd: number | null;
  totalCostUsd: number | null;
  unitActualCostUsd: number | null;
  profitPerUnitUsd: number | null;
  profitPct: number | null;
  totalProfitUsd: number | null;
  isProfitable: boolean | null;
  /** What the headline figure is waiting for, when there is no headline. */
  waitingFor: string | null;
}

export interface CostingOverviewSummary {
  orders: number;
  /** Orders with a profit per unit — the ones the totals are over. */
  costed: number;
  waiting: number;
  profitable: number;
  losing: number;
  /** Σ total cost over costed orders with a total. */
  totalCostUsd: number | null;
  /** Σ total profit over costed orders with a total profit. */
  totalProfitUsd: number | null;
  /** Revenue-weighted margin: Σ profit ÷ Σ (sell price × shipped) over costed orders. */
  marginPct: number | null;
  /** Mean of the per-order margins, for comparison with the weighted one. */
  avgProfitPct: number | null;
}

/**
 * The one sentence for an order with no headline, chosen in the order a person
 * would fix things: a price first, then a shipment, then the costs.
 */
export function costingHeadlineReason(waiting: Partial<Record<string, string>>): string | null {
  return waiting.sellPriceUsd ?? waiting.shippedQty ?? waiting.totalCostUsd ?? waiting.unitActualCostUsd
    ?? waiting.profitPerUnitUsd ?? null;
}

export function summariseCostingOverview(rows: readonly CostingOverviewRow[]): CostingOverviewSummary {
  const costed = rows.filter((r) => r.profitPerUnitUsd != null);
  const withTotals = costed.filter((r) => r.totalProfitUsd != null && r.sellPriceUsd != null && r.shippedQty != null);
  const revenue = sum(withTotals.map((r) => r.sellPriceUsd! * r.shippedQty!));
  const profit = withTotals.length > 0 ? sum(withTotals.map((r) => r.totalProfitUsd)) : null;
  const cost = costed.some((r) => r.totalCostUsd != null) ? sum(costed.map((r) => r.totalCostUsd)) : null;
  return {
    orders: rows.length,
    costed: costed.length,
    waiting: rows.length - costed.length,
    profitable: costed.filter((r) => r.isProfitable === true).length,
    losing: costed.filter((r) => r.isProfitable === false).length,
    totalCostUsd: cost,
    totalProfitUsd: profit,
    marginPct: profit != null && revenue > 0 ? safePct(profit, revenue) : null,
    avgProfitPct: costed.some((r) => r.profitPct != null)
      ? safeDiv(sum(costed.map((r) => r.profitPct)), costed.filter((r) => r.profitPct != null).length)
      : null,
  };
}
