/**
 * Costing: two pages behind one step.
 *
 * Actual Costing — what the order really cost, once it is made (the sheet).
 * Planned Costing — what it should cost, worked out from the plan before
 * production (`PlannedCostingCard`). A switch at the top picks one; the
 * choice is kept in the address (`?view=planned`) so a link opens the same page.
 */

import { useSearchParams } from 'react-router-dom';
import type { OrderDetailDto } from '@opsflow/shared';
import { ActualCostingSheet } from '../../components/ActualCostingSheet';
import { PlannedCostingCard } from '../../components/PlannedCostingCard';
import { useAuth } from '../../lib/auth';
import { clsx } from '../../components/ui';

type View = 'actual' | 'planned';

export function CostingTab({ order }: { order: OrderDetailDto }) {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const canSee = can('costing:read') && order.costing != null;
  const view: View = canSee && params.get('view') === 'planned' ? 'planned' : 'actual';

  const pick = (v: View) => {
    const next = new URLSearchParams(params);
    if (v === 'planned') next.set('view', 'planned'); else next.delete('view');
    setParams(next, { replace: true });
  };

  return (
    <>
      {canSee && (
        <div className="no-print px-5 pt-5">
          <div role="tablist" aria-label="Costing" className="inline-flex rounded-lg border border-ink-200 bg-ink-50 p-1">
            {([
              ['actual', 'Actual Costing', 'What the order really cost'],
              ['planned', 'Planned Costing', 'What it should cost, from the plan'],
            ] as const).map(([key, label, hint]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                title={hint}
                onClick={() => pick(key)}
                className={clsx(
                  'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                  view === key ? 'bg-ink-900 text-white shadow-sm' : 'text-ink-600 hover:bg-white hover:text-ink-900',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {view === 'actual'
        ? <ActualCostingSheet order={order} />
        : <div className="p-5"><PlannedCostingCard order={order} c={order.costing!} /></div>}
    </>
  );
}
