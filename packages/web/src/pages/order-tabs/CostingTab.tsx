/**
 * Actual costing.
 *
 * The sheet itself is `ActualCostingSheet` — the workbook's grid, read from
 * the order rather than retyped. This tab adds the one thing a worksheet
 * cannot express: costs nobody planned for, added by hand, kept apart from the
 * derived figures so a recalculation can never quietly erase them.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { OrderDetailDto } from '@opsflow/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ActualCostingSheet } from '../../components/ActualCostingSheet';
import { CostingEditor } from '../../components/CostingEditor';
import { Card, CardHeader } from '../../components/ui';

export function CostingTab({ order }: { order: OrderDetailDto }) {
  const { can } = useAuth();
  const [addingCosts, setAddingCosts] = useState(false);

  const costing = useQuery({
    queryKey: ['costing', order.id],
    queryFn: () => api.steps.costing(order.id),
    enabled: can('costing:read'),
  });

  return (
    <div>
      <ActualCostingSheet order={order} />

      {can('costing:write') && (
        <div className="no-print px-5 pb-5">
          {addingCosts ? (
            <Card>
              <CardHeader
                title="Costs added by hand"
                subtitle="Freight, a corrected rate, anything the production sections cannot know."
                action={
                  <button className="btn-secondary btn-sm" onClick={() => setAddingCosts(false)}>Done</button>
                }
              />
              <div className="p-4">
                <CostingEditor
                  orderId={order.id}
                  record={costing.data?.data ?? null}
                  derived={costing.data?.derived ?? []}
                  onSaved={() => setAddingCosts(false)}
                />
              </div>
            </Card>
          ) : (
            <button className="btn-secondary btn-sm" onClick={() => setAddingCosts(true)}>
              <Plus className="h-3.5 w-3.5" /> Add a cost the sections do not know about
            </button>
          )}
        </div>
      )}
    </div>
  );
}
