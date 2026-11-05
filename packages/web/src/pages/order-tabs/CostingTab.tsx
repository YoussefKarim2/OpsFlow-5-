/**
 * Actual costing.
 *
 * One screen, because there is one costing. It used to carry a second editor
 * underneath for hand-added costs, from when the sheet itself was read-only;
 * rows are added, edited and removed on the sheet now, and two places to do the
 * same thing is how they come to disagree.
 */

import type { OrderDetailDto } from '@opsflow/shared';
import { ActualCostingSheet } from '../../components/ActualCostingSheet';
import { ExpectedCostingCard } from '../../components/ExpectedCostingCard';
import { useAuth } from '../../lib/auth';

export function CostingTab({ order }: { order: OrderDetailDto }) {
  const { can } = useAuth();
  return (
    <>
      <ActualCostingSheet order={order} />
      {/* What the order should cost, from the plan — under the actual costing. */}
      {can('costing:read') && order.costing && <ExpectedCostingCard order={order} c={order.costing} />}
    </>
  );
}
