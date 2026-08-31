/**
 * The audit log.
 *
 * Three records, deliberately kept apart and shown as three tabs, because they
 * answer three different questions:
 *
 *   What changed — the factory's day in plain words, with before and after
 *                  values and the name against each. This is what most people
 *                  want, so it opens first.
 *   Activity     — what a person did, in a sentence a service chose to write.
 *                  "Khaled issued 500 poly bags."
 *   Field changes— which column moved from what to what, written automatically
 *                  by Prisma middleware so no endpoint can forget to record it.
 *
 * "What changed" used to be its own sidebar entry. It is the friendly half of
 * this page rather than a separate place, which is one fewer thing in the
 * sidebar and one more reason to open the audit log.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Download } from 'lucide-react';
import { api } from '../../lib/api';
import {
  Card, EmptyState, ErrorNote, Field, Spinner, TabStrip, clsx,
} from '../../components/ui';
import { WhatChangedPage } from '../WhatChanged';

type Tab = 'whatchanged' | 'activity' | 'changes';

interface Filters {
  actorId: string;
  action: string;
  entityType: string;
  from: string;
  to: string;
  page: number;
}

const EMPTY: Filters = { actorId: '', action: '', entityType: '', from: '', to: '', page: 1 };

export function AuditLogPage() {
  const [tab, setTab] = useState<Tab>('whatchanged');
  const [filters, setFilters] = useState<Filters>(EMPTY);

  const { data: facets } = useQuery({ queryKey: ['admin', 'audit', 'facets'], queryFn: api.admin.auditFacets });

  const params = {
    actorId: filters.actorId || undefined,
    action: filters.action || undefined,
    entityType: tab === 'changes' ? filters.entityType || undefined : undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    page: filters.page,
    pageSize: 50,
  };

  const activity = useQuery({
    queryKey: ['admin', 'activity', params],
    queryFn: () => api.admin.activity(params),
    enabled: tab === 'activity',
  });

  const changes = useQuery({
    queryKey: ['admin', 'audit', params],
    queryFn: () => api.admin.audit(params),
    enabled: tab === 'changes',
  });

  const query = tab === 'activity' ? activity : changes;
  const actionOptions = tab === 'activity' ? facets?.activityActions ?? [] : facets?.auditActions ?? [];

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));

  return (
    <div className="space-y-4 p-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Audit log</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Sign-ins, account changes and every recorded edit. Records are written automatically and
          cannot be edited or removed from inside the application.
        </p>
      </div>

      {/* The friendly view: what changed, in plain words, with its own filters.
          It brings the whole What Changed page with it rather than a cut-down
          copy — the two used to be separate pages showing the same events. */}
      {tab === 'whatchanged' && (
        <Card>
          <div className="px-4 pt-2">
            <TabStrip
              tabs={[
                { key: 'whatchanged' as Tab, label: 'What changed' },
                { key: 'activity' as Tab, label: 'Activity' },
                { key: 'changes' as Tab, label: 'Field changes' },
              ]}
              active={tab}
              onChange={(t) => { setTab(t); setFilters(EMPTY); }}
            />
          </div>
          <div className="-mt-1">
            <WhatChangedPage embedded />
          </div>
        </Card>
      )}

      {tab === 'whatchanged' ? null : (
      <>

      <Card>
        <div className="px-4 pt-2">
          <TabStrip
            tabs={[
              { key: 'whatchanged' as Tab, label: 'What changed' },
              { key: 'activity' as Tab, label: 'Activity' },
              { key: 'changes' as Tab, label: 'Field changes' },
            ]}
            active={tab}
            onChange={(t) => { setTab(t); setFilters(EMPTY); }}
          />
        </div>

        <div className="grid gap-3 border-b border-ink-200 bg-ink-50 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="User">
            <select className="input" value={filters.actorId} onChange={(e) => set({ actorId: e.target.value })}>
              <option value="">Anyone</option>
              {(facets?.actors ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Action">
            <select className="input" value={filters.action} onChange={(e) => set({ action: e.target.value })}>
              <option value="">Any action</option>
              {actionOptions.map((a) => <option key={a} value={a}>{humanise(a)}</option>)}
            </select>
          </Field>
          {tab === 'changes' && (
            <Field label="Record type">
              <select className="input" value={filters.entityType} onChange={(e) => set({ entityType: e.target.value })}>
                <option value="">Anything</option>
                {(facets?.entityTypes ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          )}
          <Field label="From">
            <input type="date" className="input" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" className="input" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
          </Field>
          <div className="flex items-end gap-2">
            <button className="btn-secondary btn-sm" onClick={() => setFilters(EMPTY)}>Clear</button>
            {query.data && query.data.data.length > 0 && (
              <button
                className="btn-ghost btn-sm"
                onClick={() => downloadCsv(tab, query.data!.data as unknown as Array<Record<string, unknown>>)}
                title="Download the rows currently shown"
              >
                <Download className="h-3.5 w-3.5" /> CSV
              </button>
            )}
          </div>
        </div>

        {query.isLoading ? (
          <Spinner label="Loading…" />
        ) : query.error ? (
          <div className="p-4"><ErrorNote error={query.error} onRetry={query.refetch} /></div>
        ) : (query.data?.data.length ?? 0) === 0 ? (
          <EmptyState
            title="Nothing recorded"
            detail={
              filters === EMPTY
                ? 'Actions will appear here as people use the system.'
                : 'No records match these filters. Try widening the date range.'
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              {tab === 'activity'
                ? <ActivityTable rows={activity.data?.data ?? []} />
                : <ChangesTable rows={changes.data?.data ?? []} />}
            </div>
            <Pagination
              page={query.data!.page}
              totalPages={query.data!.totalPages}
              total={query.data!.total}
              onPage={(p) => setFilters((f) => ({ ...f, page: p }))}
            />
          </>
        )}
      </Card>
      </>
      )}
    </div>
  );
}

function ActivityTable({ rows }: { rows: Array<import('../../lib/api').ActivityRow> }) {
  return (
    <table className="w-full">
      <thead className="border-b border-ink-200 bg-ink-50">
        <tr>
          <th className="th">When</th>
          <th className="th">User</th>
          <th className="th">Action</th>
          <th className="th">What happened</th>
          <th className="th">Order</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-ink-100">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="td text-ink-500">{fmtDateTime(r.createdAt)}</td>
            <td className="td font-medium text-ink-800">{r.actorName}</td>
            <td className="td"><ActionChip action={r.action} /></td>
            <td className="td whitespace-normal text-ink-700">{r.summary}</td>
            <td className="td">
              {r.orderId
                ? <Link to={`/orders/${r.orderId}`} className="font-mono text-xs text-accent-700 hover:underline">{r.orderPoNumber}</Link>
                : <span className="text-ink-400">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChangesTable({ rows }: { rows: Array<import('../../lib/api').AuditRow> }) {
  return (
    <table className="w-full">
      <thead className="border-b border-ink-200 bg-ink-50">
        <tr>
          <th className="th">When</th>
          <th className="th">User</th>
          <th className="th">Record</th>
          <th className="th">Field</th>
          <th className="th">Change</th>
          <th className="th">Reason</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-ink-100">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="td text-ink-500">{fmtDateTime(r.createdAt)}</td>
            <td className="td font-medium text-ink-800">{r.actorName}</td>
            <td className="td">
              <span className="text-ink-700">{r.entityType}</span>
              {r.orderPoNumber && (
                <Link to={`/orders/${r.orderId}`} className="ml-1.5 font-mono text-2xs text-accent-700 hover:underline">
                  {r.orderPoNumber}
                </Link>
              )}
            </td>
            <td className="td"><code className="text-2xs text-ink-600">{r.field}</code></td>
            <td className="td whitespace-normal">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="max-w-[16rem] truncate rounded bg-ink-100 px-1.5 py-0.5 text-ink-600" title={r.oldValue ?? ''}>
                  {display(r.oldValue)}
                </span>
                <ArrowRight className="h-3 w-3 shrink-0 text-ink-400" />
                <span
                  className={clsx(
                    'max-w-[16rem] truncate rounded px-1.5 py-0.5',
                    r.action === 'DELETE' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800',
                  )}
                  title={r.newValue ?? ''}
                >
                  {display(r.newValue)}
                </span>
              </div>
            </td>
            <td className="td whitespace-normal text-ink-600">{r.reason ?? <span className="text-ink-400">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ActionChip({ action }: { action: string }) {
  const tone =
    action.startsWith('LOGIN_FAILED') || action.startsWith('LOGIN_LOCKED') || action.startsWith('LOGIN_BLOCKED')
      ? 'bg-red-50 text-red-700 ring-red-200'
      : action.startsWith('USER_') || action === 'LOGIN'
        ? 'bg-accent-50 text-accent-700 ring-accent-200'
        : 'bg-ink-100 text-ink-600 ring-ink-200';
  return <span className={clsx('chip', tone)}>{humanise(action)}</span>;
}

function Pagination({
  page, totalPages, total, onPage,
}: {
  page: number; totalPages: number; total: number; onPage: (p: number) => void;
}) {
  if (totalPages <= 1) {
    return <div className="border-t border-ink-200 px-4 py-2.5 text-xs text-ink-500">{total} record{total === 1 ? '' : 's'}</div>;
  }
  return (
    <div className="flex items-center justify-between border-t border-ink-200 px-4 py-2.5">
      <p className="text-xs text-ink-500">
        Page {page} of {totalPages} · {total.toLocaleString()} records
      </p>
      <div className="flex gap-1.5">
        <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <button className="btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** ACCOUNT_DISABLED → "Account disabled". */
function humanise(action: string): string {
  const s = action.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function display(value: string | null): string {
  if (value === null) return '—';
  if (value === '') return '(empty)';
  return value;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Exports the rows on screen, not the whole log: a filtered export is a
 * deliberate act, and streaming the entire table would be a different feature
 * with different access considerations.
 */
function downloadCsv(tab: Tab, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!);
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => escape(r[c])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `opsflow-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
