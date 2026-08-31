import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { AlertTriangle, Clock, ArrowRight } from 'lucide-react';
import { fmtDateShort, fmtDate, ORDER_STATUS_LABEL, type OrderStatus } from '@opsflow/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Card, CardHeader, StatTile, ProgressBar, HealthBadge, SeverityDot,
  Spinner, ErrorNote, EmptyState, Avatar, clsx,
} from '../components/ui';

export function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: api.dashboard.get,
    refetchInterval: 120_000,
  });

  // Declared before the early returns — a hook after a conditional return is
  // called on some renders and not others, which React does not allow.
  const [showAllActions, setShowAllActions] = useState(false);
  const [mineOnlyPref, setMineOnlyPref] = useState(true);

  if (isLoading) return <Spinner label="Loading the order book…" />;
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;
  if (!data) return null;

  const c = data.cards;
  // Default to your own orders, but never show an empty list because of it: a
  // coordinator with nothing of their own should still see the factory.
  const mineOnly = mineOnlyPref && data.actionItemCounts.mine > 0;
  const actions = data.actionItems.filter((a) => !mineOnly || a.mine);
  const visibleActions = showAllActions ? actions : actions.slice(0, 6);

  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">{greeting()}, {firstName(user?.name)}</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {data.actionItemCounts.total === 0
              ? 'Nothing needs your attention right now.'
              : `${data.actionItemCounts.total} thing${data.actionItemCounts.total === 1 ? '' : 's'} need attention` +
                (data.actionItemCounts.mine > 0 ? `, ${data.actionItemCounts.mine} on your orders` : '') + '.'}
          </p>
        </div>
        <Link to="/orders" className="btn-secondary btn-sm">
          All orders <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* Triage — §25. Three numbers, in the order a coordinator needs them:
          what is stopped, what is slipping, what is fine. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <TriageTile
          tone="red" count={c.blocked} label="Blocked"
          detail="A stage requirement is unmet"
          onClick={() => navigate('/orders?health=blocked')}
        />
        <TriageTile
          tone="amber" count={c.atRisk} label="At risk"
          detail="Late, behind, or carrying an alert"
          onClick={() => navigate('/orders?health=risk')}
        />
        <TriageTile
          tone="emerald" count={c.onTrack} label="On track"
          detail="Nothing outstanding"
          onClick={() => navigate('/orders')}
        />
      </div>

      {/* Action items — the heart of §25. One row per thing to do. */}
      <Card>
        <CardHeader
          title="What needs attention"
          subtitle={
            actions.length === 0
              ? mineOnly ? 'Nothing on your orders.' : 'Nothing outstanding across the factory.'
              : `${actions.length} item${actions.length === 1 ? '' : 's'}, most urgent first`
          }
          action={
            data.actionItemCounts.mine > 0 && (
              <div className="flex rounded-md border border-ink-300 p-0.5">
                <button
                  className={clsx('rounded px-2 py-0.5 text-xs', mineOnly ? 'bg-accent-600 text-white' : 'text-ink-600')}
                  onClick={() => setMineOnlyPref(true)}
                >
                  My orders
                </button>
                <button
                  className={clsx('rounded px-2 py-0.5 text-xs', !mineOnly ? 'bg-accent-600 text-white' : 'text-ink-600')}
                  onClick={() => setMineOnlyPref(false)}
                >
                  Everything
                </button>
              </div>
            )
          }
        />

        {actions.length === 0 ? (
          <EmptyState
            title="Nothing needs attention"
            detail={mineOnly
              ? 'No blockers or alerts on the orders you coordinate.'
              : 'No order in the factory has an unmet requirement or an open alert.'}
          />
        ) : (
          <>
            <ul className="divide-y divide-ink-100">
              {visibleActions.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-4 py-3 hover:bg-ink-50/60">
                  <SeverityDot severity={a.severity} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <Link
                        to={`/orders/${a.orderId}`}
                        className="font-mono text-xs font-semibold text-accent-700 hover:underline"
                      >
                        {a.poNumber}
                      </Link>
                      <span className="truncate text-sm font-medium text-ink-900">{a.title}</span>
                      {a.mine && <span className="chip bg-accent-50 text-accent-700 ring-accent-200">Yours</span>}
                    </div>
                    <p className="mt-0.5 text-xs leading-snug text-ink-600">{a.detail}</p>
                  </div>
                  <Link
                    to={`/orders/${a.orderId}?tab=${a.tab}`}
                    className="btn-secondary btn-sm shrink-0"
                    title={a.actionLabel}
                  >
                    {shortAction(a.actionLabel)}
                  </Link>
                </li>
              ))}
            </ul>
            {actions.length > 6 && (
              <button
                className="w-full border-t border-ink-100 py-2 text-xs font-medium text-accent-700 hover:bg-ink-50"
                onClick={() => setShowAllActions((v) => !v)}
              >
                {showAllActions ? 'Show fewer' : `Show all ${actions.length}`}
              </button>
            )}
          </>
        )}
      </Card>

      {/* The order book by the numbers. Secondary to the list above: these are
          for scanning the shape of the week, not for finding today's problem. */}
      <details className="group" open>
        <summary className="mb-2 cursor-pointer list-none text-2xs font-semibold uppercase tracking-wider text-ink-500 hover:text-ink-700">
          Order book <span className="ml-1 font-normal normal-case tracking-normal text-ink-400 group-open:hidden">— show</span>
        </summary>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Active Orders"     value={c.totalActive}      tone="neutral" onClick={() => navigate('/orders')} />
          <StatTile label="Due Soon"          value={c.dueSoon}          tone={c.dueSoon > 0 ? 'amber' : 'neutral'} sub="within 14 days" onClick={() => navigate('/orders?due=soon')} />
          <StatTile label="Late"              value={c.late}             tone={c.late > 0 ? 'red' : 'emerald'} onClick={() => navigate('/orders?status=PRODUCTION_DELAYED')} />
          <StatTile label="Material Short"    value={c.materialShortages} tone={c.materialShortages > 0 ? 'red' : 'neutral'} sub="not enough stock" onClick={() => navigate('/inventory/materials?status=low')} />
          <StatTile label="Waiting Approval"  value={c.waitingApproval}  tone={c.waitingApproval > 0 ? 'blue' : 'neutral'} onClick={() => navigate('/orders?status=WAITING_APPROVAL')} />
          <StatTile label="In Production"     value={c.inProduction}     tone="accent" onClick={() => navigate('/orders?status=IN_PRODUCTION')} />
          <StatTile label="Waiting Materials" value={c.waitingMaterials} tone={c.waitingMaterials > 0 ? 'amber' : 'neutral'} onClick={() => navigate('/orders?status=READY_FOR_PRODUCTION')} />
          <StatTile label="Waiting External"  value={c.waitingExternal}  tone={c.waitingExternal > 0 ? 'blue' : 'neutral'} onClick={() => navigate('/external')} />
          <StatTile label="Waiting Quality"   value={c.waitingQuality}   tone={c.waitingQuality > 0 ? 'amber' : 'neutral'} onClick={() => navigate('/quality')} />
          <StatTile label="Ready to Ship"     value={c.readyToShip}      tone={c.readyToShip > 0 ? 'emerald' : 'neutral'} onClick={() => navigate('/shipping')} />
        </div>
      </details>

      {/* Orders requiring attention */}
      <Card>
        <CardHeader
          title="Orders Requiring Attention"
          subtitle={
            data.ordersRequiringAttention.length === 0
              ? 'Nothing is flagged.'
              : `${data.ordersRequiringAttention.length} order${data.ordersRequiringAttention.length === 1 ? '' : 's'} with alerts, delays or a near deadline`
          }
        />
        {data.ordersRequiringAttention.length === 0 ? (
          <EmptyState title="Everything is on track" detail="No order has a critical alert or an imminent deadline." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">PO / Order</th>
                  <th className="th">Client</th>
                  <th className="th">Coordinator</th>
                  <th className="th">Stage</th>
                  <th className="th w-32">Progress</th>
                  <th className="th">Due</th>
                  <th className="th text-right">Days</th>
                  <th className="th">Status</th>
                  <th className="th">Next Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.ordersRequiringAttention.map((o) => (
                  <tr
                    key={o.id}
                    onClick={() => navigate(`/orders/${o.id}`)}
                    className="cursor-pointer transition-colors hover:bg-accent-50/40"
                  >
                    <td className="td">
                      <div className="flex items-center gap-2">
                        {o.alertCounts.critical > 0 && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" />}
                        <div className="min-w-0">
                          <p className="font-mono text-xs font-semibold text-accent-700">{o.poNumber}</p>
                          <p className="truncate text-xs text-ink-600">{o.orderName}</p>
                        </div>
                      </div>
                    </td>
                    <td className="td text-xs">{o.clientName}</td>
                    <td className="td">
                      {o.coordinatorName ? (
                        <span className="flex items-center gap-1.5">
                          <Avatar name={o.coordinatorName} size="sm" />
                          <span className="text-xs">{o.coordinatorName}</span>
                        </span>
                      ) : <span className="text-xs text-ink-400">Unassigned</span>}
                    </td>
                    <td className="td text-xs">{o.currentStageLabel ?? '—'}</td>
                    <td className="td"><ProgressBar value={o.progressPct} showLabel /></td>
                    <td className="td text-xs">{fmtDateShort(o.requiredDeliveryDate)}</td>
                    <td className="td text-right">
                      <span className={clsx(
                        'tnum text-xs font-semibold',
                        o.daysRemaining == null ? 'text-ink-400'
                        : o.daysRemaining < 0 ? 'text-red-600'
                        : o.daysRemaining <= 7 ? 'text-amber-600' : 'text-ink-600',
                      )}>
                        {o.daysRemaining == null ? '—' : o.daysRemaining < 0 ? `${Math.abs(o.daysRemaining)} late` : o.daysRemaining}
                      </span>
                    </td>
                    <td className="td"><HealthBadge health={o.health} /></td>
                    <td className="td max-w-[16rem]">
                      <p className="truncate text-xs text-ink-700">{o.nextAction}</p>
                      {o.nextActionDepartment && (
                        <p className="truncate text-2xs text-ink-400">{o.nextActionDepartment}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Production trend */}
        <Card className="lg:col-span-2">
          <CardHeader title="Factory Production" subtitle="Sewing output, last 14 days" />
          <div className="p-4">
            {data.productionTrend.length === 0 ? (
              <EmptyState title="No production recorded yet" detail="Daily output will appear here once the production manager starts logging it." />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={data.productionTrend} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="prod" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3286fb" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="#3286fb" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eceef2" vertical={false} />
                  <XAxis
                    dataKey="date" tickFormatter={(d: string) => fmtDateShort(d)}
                    tick={{ fontSize: 11, fill: '#65758d' }} axisLine={false} tickLine={false}
                  />
                  <YAxis tick={{ fontSize: 11, fill: '#65758d' }} axisLine={false} tickLine={false} width={48} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #d5dae2' }}
                    labelFormatter={(d) => fmtDate(String(d))}
                    formatter={(v: number) => [`${v.toLocaleString()} pcs`, 'Sewn']}
                  />
                  <Area type="monotone" dataKey="qty" stroke="#1c67f0" strokeWidth={2} fill="url(#prod)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {/* Status breakdown */}
        <Card>
          <CardHeader title="Order Book" subtitle="By derived status" />
          <div className="space-y-2 p-4">
            {data.statusBreakdown.length === 0 && <p className="text-sm text-ink-500">No orders yet.</p>}
            {data.statusBreakdown
              .sort((a, b) => b.count - a.count)
              .map((s) => (
                <div key={s.status} className="flex items-center gap-2">
                  <span className="w-40 shrink-0 truncate text-xs text-ink-600">
                    {ORDER_STATUS_LABEL[s.status as OrderStatus]}
                  </span>
                  <ProgressBar
                    value={(s.count / Math.max(1, data.cards.totalActive)) * 100}
                    tone="accent" className="flex-1"
                  />
                  <span className="tnum w-6 text-right text-xs font-semibold text-ink-700">{s.count}</span>
                </div>
              ))}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* My tasks */}
        <Card>
          <CardHeader
            title="My Open Tasks"
            subtitle={`${data.myOpenTasks.length} assigned to you or your department`}
            action={<Link to="/my-tasks" className="btn-ghost btn-sm">View all</Link>}
          />
          {data.myOpenTasks.length === 0 ? (
            <EmptyState title="Nothing waiting on you" detail="Tasks assigned to you or your department appear here." />
          ) : (
            <ul className="divide-y divide-ink-100">
              {data.myOpenTasks.slice(0, 6).map((t) => (
                <li key={t.id}>
                  <Link
                    to={`/orders/${t.orderId}?tab=tasks`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50"
                  >
                    <span className={clsx(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      t.isOverdue ? 'bg-red-500' : t.priority === 'URGENT' ? 'bg-orange-500' : 'bg-ink-300',
                    )} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink-800">{t.title}</p>
                      <p className="truncate text-2xs text-ink-500">
                        {t.orderPoNumber} · {t.departmentLabel}
                      </p>
                    </div>
                    <span className={clsx(
                      'tnum shrink-0 text-2xs font-semibold',
                      t.isOverdue ? 'text-red-600' : 'text-ink-500',
                    )}>
                      {t.daysRemaining == null ? '—'
                        : t.daysRemaining < 0 ? `${Math.abs(t.daysRemaining)}d late`
                        : `${t.daysRemaining}d`}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Activity */}
        <Card>
          <CardHeader title="Recent Activity" subtitle="Across all orders" />
          {data.recentActivity.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="divide-y divide-ink-100">
              {data.recentActivity.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-start gap-2.5 px-4 py-2.5">
                  <Avatar name={a.actorName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug text-ink-700">
                      <span className="font-medium text-ink-900">{a.actorName}</span> {a.summary}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-2xs text-ink-400">
                      <Clock className="h-3 w-3" />{fmtDate(a.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * One of the three triage numbers.
 *
 * Deliberately larger and plainer than a StatTile: these three answer "how bad
 * is today" before any detail, and they should be readable across a desk.
 * Colour is never the only signal — each carries a word.
 */
function TriageTile({
  tone, count, label, detail, onClick,
}: {
  tone: 'red' | 'amber' | 'emerald';
  count: number;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  const styles = {
    red:     { ring: 'ring-red-200',     bg: count > 0 ? 'bg-red-50' : 'bg-white',     num: count > 0 ? 'text-red-700' : 'text-ink-400',     dot: 'bg-red-500' },
    amber:   { ring: 'ring-amber-200',   bg: count > 0 ? 'bg-amber-50' : 'bg-white',   num: count > 0 ? 'text-amber-700' : 'text-ink-400',   dot: 'bg-amber-500' },
    emerald: { ring: 'ring-emerald-200', bg: 'bg-white',                               num: 'text-emerald-700',                              dot: 'bg-emerald-500' },
  }[tone];

  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-3 rounded-lg px-4 py-3 text-left ring-1 ring-inset transition-colors hover:brightness-[0.98]',
        styles.ring, styles.bg,
      )}
    >
      <span className={clsx('h-2 w-2 shrink-0 rounded-full', styles.dot)} />
      <span className={clsx('tnum text-2xl font-semibold leading-none', styles.num)}>{count}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink-900">{label}</span>
        <span className="block truncate text-2xs text-ink-500">{detail}</span>
      </span>
    </button>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function firstName(name: string | undefined): string {
  return name?.split(/\s+/)[0] ?? 'there';
}

/** The full next-action sentence is the tooltip; the button gets a verb. */
function shortAction(action: string): string {
  const first = action.split(/[\s,—]/)[0] ?? 'Open';
  return first.charAt(0).toUpperCase() + first.slice(1);
}
