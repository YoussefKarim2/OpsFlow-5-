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

export function CostingTab({ order }: { order: OrderDetailDto }) {
  return <ActualCostingSheet order={order} />;
}
