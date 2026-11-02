/**
 * The production line an order runs on: its machines and its daily target —
 * the Production sheet's "Machine Qty / Machine Type" table and its
 * "Target Production / Day".
 */

/** The machine types the factory's sheet lists, in its order. */
export const LINE_MACHINE_TYPES = ['Single', 'Over', 'Flat Seam', 'Cover Stitch', 'Elastic', 'Bar tack'] as const;

export interface LineMachine {
  type: string;
  /** Machines of this type on the line; null when the sheet leaves it blank. */
  qty: number | null;
}

export interface LinePlan {
  targetPerDay: number | null;
  lineName: string | null;
  machines: LineMachine[];
  /** The sheet's Total row: the machines counted. */
  totalMachines: number;
}

/** A stored machine list read back safely: anything malformed is dropped, never thrown on. */
export function readLineMachines(raw: unknown): LineMachine[] {
  if (!Array.isArray(raw)) return [];
  const out: LineMachine[] = [];
  for (const m of raw) {
    if (m == null || typeof m !== 'object') continue;
    const type = typeof (m as { type?: unknown }).type === 'string' ? (m as { type: string }).type.trim() : '';
    const q = (m as { qty?: unknown }).qty;
    const qty = typeof q === 'number' && Number.isFinite(q) && q >= 0 ? Math.round(q) : null;
    if (type) out.push({ type, qty });
  }
  return out;
}

export function linePlanOf(o: { targetPerDay: number | null; productionLineName: string | null; lineMachines: unknown }): LinePlan {
  const machines = readLineMachines(o.lineMachines);
  return {
    targetPerDay: o.targetPerDay,
    lineName: o.productionLineName,
    machines,
    totalMachines: machines.reduce((a, m) => a + (m.qty ?? 0), 0),
  };
}

/**
 * Days the remaining pieces take at the target, rounded up; null without a
 * target or with nothing left.
 */
export function daysAtTarget(remaining: number, targetPerDay: number | null): number | null {
  if (targetPerDay == null || targetPerDay <= 0 || remaining <= 0) return null;
  return Math.ceil(remaining / targetPerDay);
}
