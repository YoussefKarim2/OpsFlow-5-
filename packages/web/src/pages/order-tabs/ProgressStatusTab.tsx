/**
 * Step 6 — Progress Status.
 *
 * The workbook's `Progress Status` sheet is a checklist of twenty-seven lines
 * with a department against each. This screen is that checklist plus the one
 * thing the sheet could never show: whether the order is actually going to make
 * its date.
 *
 * Everything here is derived. Nothing on this screen is typed, and nothing on
 * it is stored — the percentage, the blockers and the delivery risk are all
 * computed from the order's own facts on the request that renders them, so a
 * shortage cleared this morning cannot still be shown this afternoon.
 */

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, Clock, Minus } from 'lucide-react';
import {
  fmtDate, STEP_STATE_STYLE, DEPARTMENT_LABEL,
  type OrderDetailDto, type Department,
} from '@opsflow/shared';
import { api, type OrderStepsPayload } from '../../lib/api';
import { Card, CardHeader, ProgressBar, Num, Spinner, clsx } from '../../components/ui';

const STATE_DOT: Record<string, string> = {
  COMPLETED: 'bg-emerald-500', IN_PROGRESS: 'bg-accent-500', WAITING: 'bg-amber-400',
  BLOCKED: 'bg-red-500', NOT_REQUIRED: 'bg-ink-200', NOT_STARTED: 'bg-ink-300',
};

export function ProgressStatusTab({
  order, steps, onJump,
}: {
  order: OrderDetailDto;
  steps: OrderStepsPayload | undefined;
  onJump: (tab: string) => void;
}) {
  const { data: tasks, isLoading } = useQuery({
    queryKey: ['order-tasks', order.id],
    queryFn: () => api.orders.tasks(order.id),
  });

  if (!steps || isLoading) return <Spinner label="Working out where the order stands…" />;

  const done = steps.steps.filter((s) => s.state === 'COMPLETED');
  const outstanding = steps.steps.filter(
    (s) => !s.informational && s.state !== 'COMPLETED' && s.state !== 'NOT_REQUIRED',
  );
  const notRequired = steps.steps.filter((s) => s.state === 'NOT_REQUIRED');
  const overdueTasks = (tasks?.data ?? []).filter((t) => t.isOverdue && t.status !== 'COMPLETED');

  return (
    <div className="space-y-4 p-5">
      {/* ── Where it stands ─────────────────────────────────────────────── */}
      <Card>
        <div className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
              Overall progress
            </span>
            <span className="tnum text-2xl font-semibold text-ink-900">
              {steps.percentComplete}%
            </span>
          </div>
          <ProgressBar value={steps.percentComplete} height="lg" />
          <p className="mt-1.5 text-xs text-ink-600">
            {steps.completedCount} of {steps.applicableCount} steps this order needs are finished
            {notRequired.length > 0 && <> · {notRequired.length} not required</>}
          </p>

          {steps.current ? (
            <button
              onClick={() => onJump(steps.current!.tab)}
              className="mt-3 flex w-full items-center gap-2 rounded-md border border-accent-200 bg-accent-50 px-3 py-2 text-left hover:bg-accent-100"
            >
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-600 text-[10px] font-semibold text-white">
                {steps.current.order}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-sm font-semibold text-accent-900">
                  Next: {steps.current.label}
                </span>
                {steps.current.missing && (
                  <span className="block text-xs text-accent-800">{steps.current.missing}</span>
                )}
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-accent-700" />
            </button>
          ) : (
            <p className="mt-3 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <CheckCircle2 className="h-4 w-4" /> Every step this order needs is finished.
            </p>
          )}
        </div>
      </Card>

      {/* ── Delivery risk ───────────────────────────────────────────────── */}
      <DeliveryRisk order={order} />

      {/* ── Blockers ────────────────────────────────────────────────────── */}
      {order.blockers.length > 0 && (
        <Card>
          <CardHeader
            title="Blockers"
            subtitle="These stop work rather than slow it"
            action={<span className="chip bg-red-50 text-red-700 ring-red-600/20">{order.blockers.length}</span>}
          />
          <ul className="divide-y divide-ink-100">
            {order.blockers.map((b) => (
              <li key={`${b.stageKey}-${b.key}`} className="flex items-start gap-3 px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-900">{b.requirement}</p>
                  <p className="mt-0.5 text-xs text-ink-600">{b.detail}</p>
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

      {overdueTasks.length > 0 && (
        <Card>
          <CardHeader
            title="Overdue tasks"
            action={<span className="chip bg-amber-50 text-amber-800 ring-amber-600/20">{overdueTasks.length}</span>}
          />
          <ul className="divide-y divide-ink-100">
            {overdueTasks.slice(0, 8).map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-4 py-2.5">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink-800">{t.title}</p>
                  <p className="text-2xs text-ink-500">
                    {t.departmentLabel}
                    {t.assignee && <> · {t.assignee.name}</>}
                    {t.dueDate && <> · was due {fmtDate(t.dueDate)}</>}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ── The eighteen, at a glance ───────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Every step"
          subtitle={`${done.length} finished · ${outstanding.length} outstanding · ${notRequired.length} not required`}
        />
        <ul className="divide-y divide-ink-100">
          {steps.steps.map((s) => (
            <li key={s.key}>
              <button
                onClick={() => onJump(s.tab)}
                className={clsx(
                  'flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-ink-50',
                  s.isCurrent && 'bg-accent-50/60',
                )}
              >
                <span className="tnum w-5 shrink-0 text-right text-xs text-ink-400">{s.order}</span>
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATE_DOT[s.state])} />
                <span className="min-w-0 flex-1">
                  <span className={clsx(
                    'block truncate text-sm',
                    s.state === 'COMPLETED' ? 'text-ink-500'
                    : s.state === 'NOT_REQUIRED' ? 'text-ink-400'
                    : 'font-medium text-ink-900',
                  )}>
                    {s.label}
                    {s.isCurrent && (
                      <span className="ml-2 rounded bg-accent-600 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-white">
                        You are here
                      </span>
                    )}
                  </span>
                  {(s.missing || s.notRequiredReason) && (
                    <span className="block truncate text-2xs text-ink-500">
                      {s.notRequiredReason ?? s.missing}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-2xs text-ink-400">
                  {DEPARTMENT_LABEL[s.department as Department]?.en ?? s.department}
                </span>
                <span className={clsx(
                  'w-24 shrink-0 text-right text-2xs font-medium',
                  s.state === 'BLOCKED' ? 'text-red-600'
                  : s.state === 'COMPLETED' ? 'text-emerald-600'
                  : 'text-ink-500',
                )}>
                  {s.informational ? 'Reference' : STEP_STATE_STYLE[s.state].label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/**
 * Will it make the date?
 *
 * The projected completion is already computed by the production analytics —
 * pieces remaining divided by the rate actually achieved so far. Showing it
 * next to the required date is the whole question a coordinator has, and the
 * workbook could never answer it because the rate was never calculated.
 *
 * When there is no production yet there is no rate, and the answer is "not
 * calculated" rather than a guess.
 */
function DeliveryRisk({ order }: { order: OrderDetailDto }) {
  const p = order.production;
  const required = order.requiredDeliveryDate;
  const projected = p.projectedCompletion;

  const late = projected && required && new Date(projected) > new Date(required);

  return (
    <Card>
      <CardHeader title="Delivery" subtitle="Whether the order is going to make its date" />
      <div className="grid grid-cols-2 gap-px bg-ink-200 sm:grid-cols-4">
        <Fact label="Required" value={required ? fmtDate(required) : 'Not set'} />
        <Fact
          label="Projected finish"
          value={projected ? fmtDate(projected) : 'Not calculated'}
          muted={!projected}
        />
        <Fact
          label="Daily rate"
          value={p.dailyRate != null ? `${Math.round(p.dailyRate).toLocaleString()} / day` : 'No production yet'}
          muted={p.dailyRate == null}
        />
        <Fact
          label="Remaining"
          value={<Num value={p.remainingQty} suffix=" pcs" />}
        />
      </div>

      <div className="px-4 py-3">
        {!projected ? (
          <p className="flex items-start gap-2 text-sm text-ink-600">
            <Minus className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
            No production has been recorded, so there is no rate to project from. Record the first
            day's output and this will say whether the order is on track.
          </p>
        ) : late ? (
          <p className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>Delivery at risk.</strong> At {Math.round(p.dailyRate ?? 0).toLocaleString()} pieces a
              day the order finishes on {fmtDate(projected)}, which is after the required
              date of {fmtDate(required)}.
            </span>
          </p>
        ) : (
          <p className="flex items-start gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              On track. At the current rate the order finishes on {fmtDate(projected)}
              {required && <>, ahead of the required date of {fmtDate(required)}</>}.
            </span>
          </p>
        )}
      </div>
    </Card>
  );
}

function Fact({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className={clsx('mt-0.5 text-sm font-semibold', muted ? 'italic text-ink-400' : 'text-ink-900')}>
        {value}
      </p>
    </div>
  );
}
