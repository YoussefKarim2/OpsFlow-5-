import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Filter, X, AlertTriangle } from 'lucide-react';
import { fmtDate, ORDER_STATUS_LABEL, STAGE_META, type OrderStatus, type StageKey } from '@opsflow/shared';
import { api } from '../lib/api';
import {
  Card, ProgressBar, StatusBadge, Num, Spinner, ErrorNote,
  EmptyState, Avatar, useDebounced, clsx,
} from '../components/ui';

export function OrdersPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [showFilters, setShowFilters] = useState(false);
  const debounced = useDebounced(search, 300);

  const filters = {
    search: debounced,
    clientId: params.get('clientId') ?? '',
    coordinatorId: params.get('coordinatorId') ?? '',
    season: params.get('season') ?? '',
    status: params.get('status') ?? '',
    stage: params.get('stage') ?? '',
    factoryId: params.get('factoryId') ?? '',
    shippingMethod: params.get('shippingMethod') ?? '',
    priority: params.get('priority') ?? '',
    page: Number(params.get('page')) || 1,
  };

  const { data: lookups } = useQuery({ queryKey: ['lookups'], queryFn: api.reference.lookups });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['orders', filters],
    queryFn: () => api.orders.list(filters),
  });

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('page');
    setParams(next);
  };

  const activeFilters = ['clientId', 'coordinatorId', 'season', 'status', 'stage', 'factoryId', 'shippingMethod', 'priority']
    .filter((k) => params.get(k));

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Orders</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {data ? `${data.total} order${data.total === 1 ? '' : 's'}` : 'Loading…'}
          </p>
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 p-3">
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search PO, order name, style, client, coordinator or external reference…"
            className="input max-w-md flex-1"
          />
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={clsx('btn-secondary btn-sm', activeFilters.length > 0 && 'border-accent-400 text-accent-700')}
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
            {activeFilters.length > 0 && (
              <span className="ml-1 rounded-full bg-accent-600 px-1.5 text-2xs text-white">{activeFilters.length}</span>
            )}
          </button>
          {activeFilters.length > 0 && (
            <button
              onClick={() => { const n = new URLSearchParams(); if (search) n.set('search', search); setParams(n); }}
              className="btn-ghost btn-sm"
            >
              <X className="h-3.5 w-3.5" /> Clear
            </button>
          )}
        </div>

        {showFilters && (
          <div className="grid gap-3 border-b border-ink-200 bg-ink-50 p-3 sm:grid-cols-3 lg:grid-cols-4">
            <FilterSelect label="Client" value={filters.clientId} onChange={(v) => setFilter('clientId', v)}
              options={(lookups?.clients ?? []).map((c) => ({ value: c.id, label: c.name }))} />
            <FilterSelect label="Coordinator" value={filters.coordinatorId} onChange={(v) => setFilter('coordinatorId', v)}
              options={(lookups?.users ?? []).filter((u) => u.department === 'COORDINATOR').map((u) => ({ value: u.id, label: u.name }))} />
            <FilterSelect label="Season" value={filters.season} onChange={(v) => setFilter('season', v)}
              options={(lookups?.values.SEASON ?? []).map((s) => ({ value: s.value, label: s.value }))} />
            <FilterSelect label="Status" value={filters.status} onChange={(v) => setFilter('status', v)}
              options={Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
            <FilterSelect label="Stage" value={filters.stage} onChange={(v) => setFilter('stage', v)}
              options={Object.entries(STAGE_META).sort((a, b) => a[1].order - b[1].order).map(([value, m]) => ({ value, label: m.label }))} />
            <FilterSelect label="Factory" value={filters.factoryId} onChange={(v) => setFilter('factoryId', v)}
              options={(lookups?.factories ?? []).map((f) => ({ value: f.id, label: f.name }))} />
            <FilterSelect label="Shipping" value={filters.shippingMethod} onChange={(v) => setFilter('shippingMethod', v)}
              options={(lookups?.values.SHIPPING_METHOD ?? []).map((s) => ({ value: s.value, label: s.value }))} />
            <FilterSelect label="Priority" value={filters.priority} onChange={(v) => setFilter('priority', v)}
              options={['URGENT', 'HIGH', 'MEDIUM', 'LOW'].map((p) => ({ value: p, label: p }))} />
          </div>
        )}

        {isLoading ? <Spinner /> :
         error ? <div className="p-4"><ErrorNote error={error} onRetry={refetch} /></div> :
         !data || data.data.length === 0 ? (
          <EmptyState
            title="No orders match"
            detail={activeFilters.length > 0 || search ? 'Try clearing a filter or broadening the search.' : 'Create an order, or import one from Excel.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">PO / Order</th>
                  <th className="th">Client</th>
                  <th className="th">Season</th>
                  <th className="th">Coordinator</th>
                  <th className="th">Factory</th>
                  <th className="th text-right">Qty</th>
                  <th className="th">Stage</th>
                  <th className="th w-32">Progress</th>
                  <th className="th">Shipping</th>
                  <th className="th">Delivery</th>
                  <th className="th">Status</th>
                  <th className="th">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.data.map((o) => (
                  <tr
                    key={o.id}
                    onClick={() => navigate(`/orders/${o.id}`)}
                    className="cursor-pointer transition-colors hover:bg-accent-50/40"
                  >
                    <td className="td">
                      <div className="flex items-center gap-2">
                        {o.alertCounts.critical > 0 && (
                          <span title={`${o.alertCounts.critical} critical alert(s)`}><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" /></span>
                        )}
                        <div className="min-w-0">
                          <p className="font-mono text-xs font-semibold text-accent-700">{o.poNumber}</p>
                          <p className="truncate text-xs text-ink-600">{o.orderName}</p>
                        </div>
                      </div>
                    </td>
                    <td className="td text-xs">{o.clientName}</td>
                    <td className="td text-xs">{o.season}</td>
                    <td className="td">
                      {o.coordinatorName ? (
                        <span className="flex items-center gap-1.5">
                          <Avatar name={o.coordinatorName} size="sm" />
                          <span className="text-xs">{o.coordinatorName}</span>
                        </span>
                      ) : <span className="text-xs text-ink-400">—</span>}
                    </td>
                    <td className="td text-xs">{o.factoryName ?? '—'}</td>
                    <td className="td text-right"><Num value={o.orderQty} /></td>
                    <td className="td text-xs">{o.currentStageLabel ?? '—'}</td>
                    <td className="td"><ProgressBar value={o.progressPct} showLabel /></td>
                    <td className="td text-xs">{fmtDate(o.promisedShippingDate)}</td>
                    <td className="td text-xs">
                      {fmtDate(o.requiredDeliveryDate)}
                      {o.daysRemaining != null && (
                        <span className={clsx(
                          'ml-1 tnum text-2xs font-semibold',
                          o.daysRemaining < 0 ? 'text-red-600' : o.daysRemaining <= 7 ? 'text-amber-600' : 'text-ink-400',
                        )}>
                          {o.daysRemaining < 0 ? `${Math.abs(o.daysRemaining)}d late` : `${o.daysRemaining}d`}
                        </span>
                      )}
                    </td>
                    <td className="td"><StatusBadge status={o.status} /></td>
                    <td className="td text-2xs text-ink-400">{fmtDate(o.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-ink-200 px-4 py-2.5">
            <p className="text-xs text-ink-500">
              Page {data.page} of {data.totalPages} · {data.total} orders
            </p>
            <div className="flex gap-2">
              <button
                disabled={data.page <= 1}
                onClick={() => setFilter('page', String(data.page - 1))}
                className="btn-secondary btn-sm"
              >
                Previous
              </button>
              <button
                disabled={data.page >= data.totalPages}
                onClick={() => setFilter('page', String(data.page + 1))}
                className="btn-secondary btn-sm"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function FilterSelect({
  label, value, onChange, options,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="input">
        <option value="">All</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export { STAGE_META, type StageKey, type OrderStatus };
