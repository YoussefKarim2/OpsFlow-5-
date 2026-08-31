/**
 * The Follow-Up Centre — the brief's section 20.
 *
 * Every open action across every order in one ranked list. This is the screen a
 * coordinator lives in: it is the answer to "what is wrong right now, and who
 * do I chase". Nothing here is calculated separately — it is the alert engine
 * and the task list projected into a single shape.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, User } from 'lucide-react';
import { fmtDate, SEVERITY_STYLE, type FollowUpItemDto } from '@opsflow/shared';
import { api } from '../lib/api';
import { Card, StatTile, Spinner, ErrorNote, EmptyState, clsx } from '../components/ui';

const KIND_LABEL: Record<FollowUpItemDto['kind'], string> = {
  TASK: 'Task', APPROVAL: 'Approval', SHORTAGE: 'Materials',
  EXTERNAL: 'External', QUALITY: 'Quality',
};

export function FollowUpPage() {
  const [mine, setMine] = useState(false);
  const [kind, setKind] = useState<string>('ALL');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['follow-up', mine],
    queryFn: () => api.dashboard.followUp(mine),
    refetchInterval: 120_000,
  });

  if (isLoading) return <Spinner label="Gathering open actions…" />;
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;
  if (!data) return null;

  const items = kind === 'ALL' ? data.data : data.data.filter((i) => i.kind === kind);
  const grouped: Array<[FollowUpItemDto['severity'], FollowUpItemDto[]]> = [
    ['CRITICAL', items.filter((i) => i.severity === 'CRITICAL')],
    ['WARNING', items.filter((i) => i.severity === 'WARNING')],
    ['ATTENTION', items.filter((i) => i.severity === 'ATTENTION')],
  ];

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Follow-Up Centre</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Every open action across every order, worst first.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-600">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="rounded border-ink-300" />
          Only my orders
        </label>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Critical" value={data.counts.critical} tone={data.counts.critical > 0 ? 'red' : 'emerald'} />
        <StatTile label="Warning" value={data.counts.warning} tone={data.counts.warning > 0 ? 'amber' : 'neutral'} />
        <StatTile label="Attention" value={data.counts.attention} tone="neutral" />
      </div>

      <div className="flex flex-wrap gap-1">
        {['ALL', 'TASK', 'APPROVAL', 'SHORTAGE', 'EXTERNAL', 'QUALITY'].map((k) => {
          const count = k === 'ALL' ? data.data.length : data.data.filter((i) => i.kind === k).length;
          return (
            <button
              key={k} onClick={() => setKind(k)}
              className={clsx(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                kind === k ? 'bg-ink-900 text-white' : 'bg-white text-ink-600 ring-1 ring-inset ring-ink-200 hover:bg-ink-50',
              )}
            >
              {k === 'ALL' ? 'Everything' : KIND_LABEL[k as FollowUpItemDto['kind']]}
              <span className={clsx('ml-1.5 tnum', kind === k ? 'text-ink-300' : 'text-ink-400')}>{count}</span>
            </button>
          );
        })}
      </div>

      {items.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing needs following up"
            detail="No overdue tasks, pending approvals, material shortages, late external operations or open quality failures."
          />
        </Card>
      ) : (
        grouped.map(([severity, list]) =>
          list.length === 0 ? null : (
            <div key={severity}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-base">{SEVERITY_STYLE[severity].icon}</span>
                <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-700">
                  {SEVERITY_STYLE[severity].label}
                </h2>
                <span className="text-xs text-ink-400">{list.length}</span>
                <div className="h-px flex-1 bg-ink-200" />
              </div>

              <Card>
                <ul className="divide-y divide-ink-100">
                  {list.map((item) => (
                    <li key={item.id}>
                      <Link
                        to={`/orders/${item.orderId}${item.tab ? `?tab=${item.tab}` : ''}`}
                        className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent-50/40"
                      >
                        <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_STYLE[item.severity].bar)} />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="font-mono text-xs font-semibold text-accent-700">{item.orderPoNumber}</span>
                            <span className="truncate text-xs text-ink-500">{item.orderName}</span>
                            <span className="chip bg-ink-100 text-ink-600 ring-ink-500/20">{KIND_LABEL[item.kind]}</span>
                          </div>
                          <p className="mt-1 text-sm font-medium text-ink-900">{item.title}</p>
                          <p className="mt-0.5 text-xs leading-relaxed text-ink-600">{item.detail}</p>
                          <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-accent-700">
                            <ArrowRight className="h-3 w-3" />{item.nextAction}
                          </p>
                        </div>

                        <div className="shrink-0 space-y-1 text-right">
                          {item.responsibleName && (
                            <p className="flex items-center justify-end gap-1 text-xs text-ink-600">
                              <User className="h-3 w-3" />{item.responsibleName}
                            </p>
                          )}
                          {item.department && <p className="text-2xs text-ink-400">{item.department}</p>}
                          {item.dueDate && (
                            <p className={clsx(
                              'tnum text-2xs font-semibold',
                              item.daysRemaining != null && item.daysRemaining < 0 ? 'text-red-600' : 'text-ink-500',
                            )}>
                              {item.daysRemaining != null && item.daysRemaining < 0
                                ? `${Math.abs(item.daysRemaining)} days late`
                                : `due ${fmtDate(item.dueDate)}`}
                            </p>
                          )}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ),
        )
      )}
    </div>
  );
}
