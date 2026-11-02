/**
 * The factory's running figures — daily cost and machines on the floor — as
 * last entered on any order's costing.
 *
 * They belong to the factory, not to an order, so a new costing starts from
 * them instead of from blanks. Held in memory because the costing is worked
 * out synchronously wherever an order is read; refreshed at start-up and after
 * every costing save, which is the only place they change.
 */

import { prisma } from '../db.js';

export interface FactoryDefaults { dailyCostUsd: number | null; machineCount: number | null; fromPo: string | null }

let current: FactoryDefaults = { dailyCostUsd: null, machineCount: null, fromPo: null };

export function factoryDefaults(): FactoryDefaults {
  return current;
}

export async function refreshFactoryDefaults(): Promise<FactoryDefaults> {
  const [daily, machines] = await Promise.all([
    prisma.costingRecord.findFirst({
      where: { dailyCostUsd: { not: null }, dailyCostEnteredAt: { not: null } },
      orderBy: { dailyCostEnteredAt: 'desc' },
      select: { dailyCostUsd: true, order: { select: { poNumber: true } } },
    }),
    prisma.costingRecord.findFirst({
      where: { machineCount: { not: null }, machineCountEnteredAt: { not: null } },
      orderBy: { machineCountEnteredAt: 'desc' },
      select: { machineCount: true },
    }),
  ]);
  current = {
    dailyCostUsd: daily?.dailyCostUsd == null ? null : Number(daily.dailyCostUsd.toString()),
    machineCount: machines?.machineCount ?? null,
    fromPo: daily?.order.poNumber ?? null,
  };
  return current;
}
