/**
 * Login, My Tasks, Notifications, Reports and the cross-order module list
 * views. Grouped in one file because each is a thin projection of an endpoint
 * the order workspace already exercises in depth.
 */

import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Check, BellOff } from 'lucide-react';
import { fmtDate, ORDER_STATUS_LABEL, PRIORITY_STYLE, type OrderStatus } from '@opsflow/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ChangePasswordForm } from './ChangePassword';
import { EmailStatusPanel } from './admin/EmailStatusPanel';
import {
  Card, CardHeader, StatTile, Num, ProgressBar, Field, Spinner, ErrorNote,
  EmptyState, Avatar, HealthBadge, StatusBadge, clsx,
} from '../components/ui';

// ── Login ───────────────────────────────────────────────────────────────────

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('hassona@age-factory.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-ink-100 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-accent-600 text-lg font-bold text-white">
            OF
          </div>
          <h1 className="text-xl font-semibold text-ink-900">OpsFlow</h1>
          <p className="mt-1 text-sm text-ink-500">Garment Order Control Centre</p>
        </div>

        <Card>
          <form onSubmit={submit} className="space-y-3 p-5">
            {error && <ErrorNote error={new Error(error)} />}
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" required autoFocus />
            </Field>
            <Field label="Password">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" required />
            </Field>
            <button type="submit" disabled={busy} className="btn-primary w-full">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </Card>

        <div className="mt-4 rounded-md border border-ink-200 bg-white/70 px-3 py-2.5">
          <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">Demo accounts</p>
          <ul className="mt-1.5 space-y-0.5 text-2xs text-ink-600">
            <li><code>hassona@age-factory.com</code> — Order Coordinator</li>
            <li><code>admin@age-factory.com</code> — Administrator</li>
            <li><code>khaled@age-factory.com</code> — Warehouse</li>
            <li><code>helmy@age-factory.com</code> — External Operations</li>
            <li><code>shimaa@age-factory.com</code> — Quality</li>
            <li><code>ahmed@soccertex.biz</code> — Super Administrator</li>
          </ul>
          <p className="mt-1.5 text-2xs text-ink-500">Password: <code>opsflow-demo-2026</code></p>
          <p className="mt-1 text-2xs text-ink-500">
            The super-administrator accounts must set a new password on first sign-in.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── My Tasks ────────────────────────────────────────────────────────────────

export function MyTasksPage() {
  const qc = useQueryClient();
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['my-tasks', includeCompleted],
    queryFn: () => api.tasks.mine(includeCompleted),
  });

  const complete = useMutation({
    mutationFn: (id: string) => api.tasks.complete(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-tasks'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => setRefusal(e instanceof ApiError ? e.message : 'Could not complete the task.'),
  });

  if (isLoading) return <Spinner />;
  const tasks = data?.data ?? [];
  const overdue = tasks.filter((t) => t.isOverdue);

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">My Tasks</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Assigned to you, or unassigned in your department.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-600">
          <input type="checkbox" checked={includeCompleted} onChange={(e) => setIncludeCompleted(e.target.checked)} className="rounded border-ink-300" />
          Show completed
        </label>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Open" value={tasks.filter((t) => t.status !== 'COMPLETED').length} />
        <StatTile label="Overdue" value={overdue.length} tone={overdue.length > 0 ? 'red' : 'emerald'} />
        <StatTile label="Urgent" value={tasks.filter((t) => t.priority === 'URGENT' && t.status !== 'COMPLETED').length} tone="amber" />
      </div>

      {refusal && <ErrorNote error={new Error(refusal)} />}

      <Card>
        {tasks.length === 0 ? (
          <EmptyState title="Nothing assigned to you" />
        ) : (
          <ul className="divide-y divide-ink-100">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-4 py-3 hover:bg-ink-50">
                <button
                  onClick={() => complete.mutate(t.id)}
                  disabled={t.status === 'COMPLETED' || complete.isPending}
                  className={clsx(
                    'mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border',
                    t.status === 'COMPLETED' ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-ink-300 bg-white hover:border-accent-500',
                  )}
                >
                  {t.status === 'COMPLETED' && <Check className="h-3 w-3" />}
                </button>
                <Link to={`/orders/${t.orderId}?tab=tasks`} className="min-w-0 flex-1">
                  <p className={clsx('text-sm', t.status === 'COMPLETED' ? 'text-ink-500 line-through' : 'font-medium text-ink-900')}>
                    {t.title}
                  </p>
                  <p className="mt-0.5 text-2xs text-ink-500">
                    <span className="font-mono font-semibold text-accent-700">{t.orderPoNumber}</span>
                    {' · '}{t.orderName}{' · '}{t.departmentLabel}{' · '}{t.stageLabel}
                  </p>
                </Link>
                <span className={clsx(
                  'tnum shrink-0 text-xs font-semibold',
                  t.isOverdue ? 'text-red-600' : 'text-ink-500',
                )}>
                  {t.dueDate ? (t.isOverdue ? `${Math.abs(t.daysRemaining ?? 0)}d late` : fmtDate(t.dueDate)) : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ── Notifications ───────────────────────────────────────────────────────────

/** Colour by priority, so an urgent line does not look like a routine one. */
const NOTIFY_DOT: Record<string, string> = {
  URGENT: 'bg-red-500', HIGH: 'bg-orange-500', NORMAL: 'bg-amber-400', LOW: 'bg-emerald-400',
};
const NOTIFY_CHIP: Record<string, string> = {
  URGENT: 'bg-red-50 text-red-700 ring-red-600/20',
  HIGH: 'bg-orange-50 text-orange-700 ring-orange-600/20',
};

export function NotificationsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['notifications'], queryFn: api.dashboard.notifications });

  const markAll = useMutation({
    mutationFn: api.dashboard.markAllRead,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markOne = useMutation({
    mutationFn: (id: string) => api.dashboard.markRead(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  if (isLoading) return <Spinner />;
  const list = data?.data ?? [];

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Notifications</h1>
          <p className="mt-0.5 text-sm text-ink-500">{data?.unreadCount ?? 0} unread</p>
        </div>
        {(data?.unreadCount ?? 0) > 0 && (
          <button onClick={() => markAll.mutate()} className="btn-secondary btn-sm">Mark all read</button>
        )}
      </div>

      <Card>
        {list.length === 0 ? (
          <EmptyState title="No notifications" detail="Task assignments, approvals, shortages, delays and quality failures arrive here." />
        ) : (
          <ul className="divide-y divide-ink-100">
            {list.map((n) => (
              <li key={n.id} className={clsx('flex items-start gap-3 px-4 py-3', !n.readAt && 'bg-accent-50/40')}>
                {!n.readAt && (
                  <span
                    className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', NOTIFY_DOT[n.priority] ?? 'bg-accent-500')}
                    title={PRIORITY_STYLE[n.priority]?.label ?? n.priority}
                  />
                )}
                {n.readAt && <BellOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-300" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <p className="text-sm font-medium text-ink-900">{n.title}</p>
                    {(n.priority === 'URGENT' || n.priority === 'HIGH') && (
                      <span className={clsx('chip', NOTIFY_CHIP[n.priority])}>
                        {PRIORITY_STYLE[n.priority].label}
                      </span>
                    )}
                  </div>
                  {n.body && <p className="mt-0.5 text-xs text-ink-600">{n.body}</p>}
                  <p className="mt-1 text-2xs text-ink-400">
                    {fmtDate(n.createdAt)}
                    {n.orderPoNumber && <> · <span className="font-mono">{n.orderPoNumber}</span></>}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {n.link && <Link to={n.link} className="btn-secondary btn-sm">Open</Link>}
                  {!n.readAt && (
                    <button onClick={() => markOne.mutate(n.id)} className="btn-ghost btn-sm">Mark read</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// The Excel import moved to its own multi-step wizard in pages/ImportWizard.tsx.
// It was a single-screen upload-and-commit; the universal importer needs an
// analysis and a column-mapping step between those two, and running two import
// UIs against one endpoint would only invite them to drift apart.

// ── Reports ─────────────────────────────────────────────────────────────────

const REPORTS = [
  { key: 'by-client', label: 'Orders by client' },
  { key: 'by-coordinator', label: 'Orders by coordinator' },
  { key: 'by-factory', label: 'Orders by factory' },
  { key: 'by-season', label: 'Orders by season' },
  { key: 'by-status', label: 'Orders by status' },
  { key: 'late-orders', label: 'Late orders' },
  { key: 'production-performance', label: 'Production performance' },
  { key: 'material-shortages', label: 'Material shortages' },
  { key: 'quality-failures', label: 'Quality failures' },
  { key: 'costing', label: 'Actual cost vs selling price' },
];

export function ReportsPage() {
  const [kind, setKind] = useState('by-client');
  const { data, isLoading } = useQuery({
    queryKey: ['report', kind],
    queryFn: () => api.reference.report(kind),
  });

  const rows = (data?.rows ?? []) as Array<Record<string, unknown>>;
  const columns = rows.length > 0 ? Object.keys(rows[0]!).filter((c) => typeof rows[0]![c] !== 'object') : [];

  return (
    <div className="space-y-4 p-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Reports</h1>
        <p className="mt-0.5 text-sm text-ink-500">Management views across the whole order book.</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {REPORTS.map((r) => (
          <button
            key={r.key} onClick={() => setKind(r.key)}
            className={clsx(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              kind === r.key ? 'bg-ink-900 text-white' : 'bg-white text-ink-600 ring-1 ring-inset ring-ink-200 hover:bg-ink-50',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader title={REPORTS.find((r) => r.key === kind)?.label ?? kind} subtitle={`${rows.length} rows`} />
        {isLoading ? <Spinner /> : rows.length === 0 ? (
          <EmptyState title="No data for this report" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  {columns.map((c) => (
                    <th key={c} className="th">
                      {c.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((row, i) => (
                  <tr key={i}>
                    {columns.map((c) => {
                      const v = row[c];
                      return (
                        <td key={c} className={clsx('td', typeof v === 'number' && 'tnum text-right')}>
                          {v == null ? <span className="italic text-ink-400">Not calculated</span>
                            : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
                            : typeof v === 'boolean' ? (v ? 'Yes' : 'No')
                            : String(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Cross-order module lists ────────────────────────────────────────────────

/**
 * The sidebar's operational sections are cross-order views of the same order
 * list, filtered and re-columned for the department that owns them.
 */
export function ModuleListPage({
  title, subtitle, filter, columns,
}: {
  title: string;
  subtitle: string;
  filter?: (o: import('@opsflow/shared').OrderSummaryDto) => boolean;
  columns?: Array<'qty' | 'produced' | 'packed' | 'shipped'>;
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['orders', 'all'], queryFn: () => api.orders.list({ pageSize: 100 }) });

  if (isLoading) return <Spinner />;
  const orders = (data?.data ?? []).filter(filter ?? (() => true));
  const cols = columns ?? ['qty', 'produced', 'packed'];

  return (
    <div className="space-y-4 p-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">{title}</h1>
        <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>
      </div>

      <Card>
        {orders.length === 0 ? (
          <EmptyState title="Nothing here right now" detail="Orders appear in this view once they reach this stage." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">PO / Order</th>
                  <th className="th">Client</th>
                  <th className="th">Coordinator</th>
                  {cols.includes('qty') && <th className="th text-right">Order qty</th>}
                  {cols.includes('produced') && <th className="th text-right">Produced</th>}
                  {cols.includes('packed') && <th className="th text-right">Packed</th>}
                  {cols.includes('shipped') && <th className="th text-right">Shipped</th>}
                  <th className="th w-32">Progress</th>
                  <th className="th">Delivery</th>
                  <th className="th">Status</th>
                  <th className="th">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {orders.map((o) => (
                  <tr key={o.id} onClick={() => navigate(`/orders/${o.id}`)} className="cursor-pointer hover:bg-accent-50/40">
                    <td className="td">
                      <p className="font-mono text-xs font-semibold text-accent-700">{o.poNumber}</p>
                      <p className="truncate text-xs text-ink-600">{o.orderName}</p>
                    </td>
                    <td className="td text-xs">{o.clientName}</td>
                    <td className="td">
                      {o.coordinatorName ? (
                        <span className="flex items-center gap-1.5">
                          <Avatar name={o.coordinatorName} size="sm" />
                          <span className="text-xs">{o.coordinatorName}</span>
                        </span>
                      ) : '—'}
                    </td>
                    {cols.includes('qty') && <td className="td text-right"><Num value={o.orderQty} /></td>}
                    {cols.includes('produced') && <td className="td text-right"><Num value={o.producedQty} /></td>}
                    {cols.includes('packed') && <td className="td text-right"><Num value={o.packedQty} /></td>}
                    {cols.includes('shipped') && <td className="td text-right"><Num value={o.shippedQty} /></td>}
                    <td className="td"><ProgressBar value={o.progressPct} showLabel /></td>
                    <td className="td text-xs">{fmtDate(o.requiredDeliveryDate)}</td>
                    <td className="td"><StatusBadge status={o.status} /></td>
                    <td className="td"><HealthBadge health={o.health} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Simple reference tables ─────────────────────────────────────────────────

export function ClientsPage() {
  const { data, isLoading } = useQuery({ queryKey: ['clients'], queryFn: api.reference.clients });
  return <RefTable title="Clients" isLoading={isLoading} rows={(data?.data ?? []) as Array<Record<string, unknown>>} />;
}

export function FactoriesPage() {
  const { data, isLoading } = useQuery({ queryKey: ['factories'], queryFn: api.reference.factories });
  return <RefTable title="Factories" isLoading={isLoading} rows={(data?.data ?? []) as Array<Record<string, unknown>>} />;
}

export function SettingsPage() {
  const { user, can } = useAuth();

  return (
    <div className="space-y-4 p-5">
      <h1 className="text-xl font-semibold text-ink-900">Settings</h1>

      <Card>
        <CardHeader title="Your account" />
        <div className="grid gap-3 p-4 sm:grid-cols-4">
          <Info label="Name" value={user?.name} />
          <Info label="Email" value={user?.email} />
          <Info
            label="Role"
            value={
              <span className="inline-flex items-center gap-1.5">
                {user?.roleLabel}
                {user?.isSuperAdmin && (
                  <span className="chip bg-accent-50 text-accent-700 ring-accent-200">Super admin</span>
                )}
              </span>
            }
          />
          <Info label="Department" value={user?.department} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Password" subtitle="Changing it signs out nothing else — your current session continues." />
        <ChangePasswordForm />
      </Card>

      {/* Behind audit:read, the same gate as the audit log — the delivery log
          names every recipient of every message, which is a staff directory. */}
      {can('audit:read') && <EmailStatusPanel />}

      <Card>
        <CardHeader title="Your permissions" subtitle={`${user?.permissions.length ?? 0} granted`} />
        <div className="flex flex-wrap gap-1 p-4">
          {(user?.permissions ?? []).map((p) => (
            <code key={p} className="rounded bg-ink-100 px-1.5 py-0.5 text-2xs text-ink-700">{p}</code>
          ))}
        </div>
      </Card>

      {/* The account list moved behind `user:manage`; every signed-in user
          could previously read every colleague's email and last sign-in. */}
      {can('user:manage') && (
        <Card>
          <CardHeader title="Administration" />
          <div className="flex flex-wrap gap-2 p-4">
            <Link to="/admin/users" className="btn-secondary">Manage users</Link>
            {can('audit:read') && <Link to="/admin/audit" className="btn-secondary">View audit log</Link>}
          </div>
        </Card>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p className="text-sm text-ink-800">{value ?? '—'}</p>
    </div>
  );
}

function RefTable({ title, isLoading, rows }: { title: string; isLoading: boolean; rows: Array<Record<string, unknown>> }) {
  const columns = rows.length > 0 ? Object.keys(rows[0]!).filter((c) => c !== 'id' && typeof rows[0]![c] !== 'object') : [];
  return (
    <div className={title === 'Users' ? '' : 'space-y-4 p-5'}>
      {title !== 'Users' && <h1 className="text-xl font-semibold text-ink-900">{title}</h1>}
      <Card>
        {title === 'Users' && <CardHeader title="Users" subtitle={`${rows.length} accounts`} />}
        {isLoading ? <Spinner /> : rows.length === 0 ? <EmptyState title={`No ${title.toLowerCase()}`} /> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>{columns.map((c) => (
                  <th key={c} className="th">{c.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c} className={clsx('td max-w-xs truncate', typeof r[c] === 'number' && 'tnum text-right')}>
                        {r[c] == null ? '—'
                          : typeof r[c] === 'boolean' ? (r[c] ? 'Yes' : 'No')
                          : typeof r[c] === 'number' ? (r[c] as number).toLocaleString()
                          : String(r[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export { ORDER_STATUS_LABEL, type OrderStatus };
