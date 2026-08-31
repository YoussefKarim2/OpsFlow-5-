/**
 * Step 15 — Follow-up, for one order.
 *
 * The workbook's Follow up sheet answers one question: where is this order
 * right now, and what is holding it up. Nothing is typed into it — every cell
 * is a formula reading the other sheets. This screen keeps that property: it
 * enters nothing, stores nothing and computes nothing of its own. It is the
 * order's blockers, alerts and overdue work, gathered in the order you would
 * chase them.
 *
 * The Follow-Up Centre in the sidebar does this across every order. This is the
 * same view narrowed to the one in front of you, so a coordinator standing on
 * step 15 does not have to leave the order to find out what is wrong with it.
 */

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock } from 'lucide-react';
import {
  fmtDate, SEVERITY_STYLE, STAGE_META,
  type OrderDetailDto, type Blocker, type Alert,
} from '@opsflow/shared';
import { api, type OrderStepsPayload } from '../../lib/api';
import { Card, EmptyState, ProgressBar, Num, clsx } from '../../components/ui';

export function OrderFollowUpTab({
  order, steps, onJump,
}: {
  order: OrderDetailDto;
  steps: OrderStepsPayload | undefined;
  onJump: (tab: string) => void;
}) {
  const { data: tasks } = useQuery({
    queryKey: ['order-tasks', order.id],
    queryFn: () => api.orders.tasks(order.id),
  });

  // The funnel is the order's own ledger totals, already derived server-side.
  const qty = (ledger: string) => order.funnel.find((f) => f.ledger === ledger)?.qty ?? 0;

  const overdue = (tasks?.data ?? []).filter((t) => t.isOverdue && t.status !== 'COMPLETED');
  const criticals = order.alerts.filter((a) => a.severity === 'CRITICAL');
  const warnings = order.alerts.filter((a) => a.severity === 'WARNING');

  const nothingWrong =
    order.blockers.length === 0 && criticals.length === 0 &&
    warnings.length === 0 && overdue.length === 0;

  return (
    <div className="space-y-4 p-5">
      {/* Where the order stands, in one line. */}
      <Card>
        <div className="grid grid-cols-1 gap-px bg-ink-200 sm:grid-cols-4">
          <Stat label="Ordered" value={qty('ORDER')} />
          <Stat label="Produced" value={qty('PRODUCED')} />
          <Stat label="Packed" value={qty('PACKED')} />
          <Stat label="Shipped" value={qty('SHIPPED')} />
        </div>
        <div className="px-4 py-3">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
              Steps completed
            </span>
            <span className="tnum text-sm font-semibold text-ink-900">
              {steps ? `${steps.completedCount} of ${steps.applicableCount}` : '—'}
            </span>
          </div>
          <ProgressBar value={steps?.percentComplete ?? 0} />
          {steps?.current && (
            <p className="mt-1.5 text-xs text-ink-600">
              Currently on step {steps.current.order} — <span className="font-medium text-ink-800">
                {steps.current.label}
              </span>
              {steps.current.missing && <>: {steps.current.missing}</>}
            </p>
          )}
          <p className="mt-1 text-2xs text-ink-500">
            Nothing on this screen is typed in. Every line is read from the step it belongs to.
          </p>
        </div>
      </Card>

      {nothingWrong && (
        <Card>
          <EmptyState
            title="Nothing is holding this order up"
            detail="No blockers, no overdue tasks and no open alerts. The current step is simply the next one to do."
          />
        </Card>
      )}

      {order.blockers.length > 0 && (
        <Card>
          <div className="card-header">
            <h3 className="card-title">Blocked — these stop work, not just slow it</h3>
            <span className="chip bg-red-50 text-red-700 ring-red-600/20">{order.blockers.length}</span>
          </div>
          <ul className="divide-y divide-ink-100">
            {order.blockers.map((b: Blocker) => (
              <li key={`${b.stageKey}-${b.key}`} className="flex items-start gap-3 px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-900">{b.requirement}</p>
                  <p className="mt-0.5 text-xs text-ink-600">{b.detail}</p>
                  <p className="mt-0.5 text-2xs text-ink-500">
                    Step {STAGE_META[b.stageKey]?.order ?? '—'} · {b.stageLabel}
                  </p>
                </div>
                {b.tab && (
                  <button className="btn-ghost btn-sm shrink-0" onClick={() => onJump(b.tab!)}>
                    {b.actionLabel ?? 'Go there'} <ArrowRight className="h-3 w-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {overdue.length > 0 && (
        <Card>
          <div className="card-header">
            <h3 className="card-title">Overdue tasks</h3>
            <span className="chip bg-amber-50 text-amber-800 ring-amber-600/20">{overdue.length}</span>
          </div>
          <ul className="divide-y divide-ink-100">
            {overdue.map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-900">{t.title}</p>
                  <p className="mt-0.5 text-2xs text-ink-500">
                    {t.stageLabel} · {t.departmentLabel}
                    {t.assignee && <> · {t.assignee.name}</>}
                    {t.dueDate && <> · was due {fmtDate(t.dueDate)}</>}
                  </p>
                </div>
                <button className="btn-ghost btn-sm shrink-0" onClick={() => onJump('tasks')}>
                  Open <ArrowRight className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(criticals.length > 0 || warnings.length > 0) && (
        <Card>
          <div className="card-header"><h3 className="card-title">Alerts</h3></div>
          <ul className="divide-y divide-ink-100">
            {[...criticals, ...warnings].map((a: Alert, i) => (
              <li key={`${a.code}-${i}`} className="flex items-start gap-3 px-4 py-3">
                <span className={clsx(
                  'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
                  SEVERITY_STYLE[a.severity].bar,
                )} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-900">{a.title}</p>
                  <p className="mt-0.5 text-xs text-ink-600">{a.detail}</p>
                  {a.nextAction && (
                    <p className="mt-0.5 text-2xs text-ink-500">Next: {a.nextAction}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="card-header">
          <h3 className="card-title">Every step that is still open</h3>
        </div>
        {steps == null ? (
          <EmptyState title="Loading the step list…" />
        ) : (
          <ul className="divide-y divide-ink-100">
            {steps.steps
              .filter((s) => s.state !== 'COMPLETED' && s.state !== 'NOT_REQUIRED')
              .map((s) => (
                <li key={s.key} className="flex items-start gap-3 px-4 py-2.5">
                  <span className="tnum mt-0.5 w-5 shrink-0 text-right text-xs text-ink-400">{s.order}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink-800">{s.label}</p>
                    {s.missing && <p className="mt-0.5 text-xs text-ink-600">{s.missing}</p>}
                  </div>
                  <button className="btn-ghost btn-sm shrink-0" onClick={() => onJump(s.tab)}>
                    Go <ArrowRight className="h-3 w-3" />
                  </button>
                </li>
              ))}
            {steps.steps.every((s) => s.state === 'COMPLETED' || s.state === 'NOT_REQUIRED') && (
              <li className="flex items-center gap-2 px-4 py-6 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" /> Every step this order needs is finished.
              </li>
            )}
          </ul>
        )}
      </Card>

      <p className="px-1 text-2xs text-ink-500">
        Chasing something across several orders?{' '}
        <Link to="/follow-up" className="font-medium text-accent-700 hover:underline">
          The Follow-Up Centre
        </Link>{' '}
        is this same view for every order at once.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className="tnum mt-0.5 text-lg font-semibold text-ink-900"><Num value={value} /></p>
    </div>
  );
}
