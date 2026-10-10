import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowUpDown, Search } from 'lucide-react';
import { fmtDate, ORDER_STATUS_LABEL, type OrderStatus, type CostingOverviewRow } from '@opsflow/shared';
import { api } from '../lib/api';
import { Card, CardHeader, StatTile, Num, StatusBadge, Spinner, ErrorNote, EmptyState, clsx } from '../components/ui';

/**
 * The Costing entry in the sidebar: every order's costing before it is opened.
 *
 * Each row is what that order's own Costing tab shows, computed by the same
 * engine on the server. An order without a headline figure says what it is
 * waiting for — a price, a shipment, a priced cost row — and the totals at the
 * top are over the orders that have one, never padded with zeros.
 */

type SortKey = 'poNumber' | 'clientName' | 'orderQty' | 'sellPriceUsd' | 'unitActualCostUsd' | 'profitPerUnitUsd' | 'profitPct' | 'totalCostUsd' | 'totalProfitUsd';
type Show = 'all' | 'costed' | 'waiting' | 'losing';

export function CostingOverviewPage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['costing-overview'], queryFn: api.costingOverview, refetchInterval: 120_000 });
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'poNumber', dir: -1 });

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    const filtered = all.filter((r) =>
      (show === 'all' || (show === 'costed' && r.profitPerUnitUsd != null) || (show === 'waiting' && r.profitPerUnitUsd == null) || (show === 'losing' && r.isProfitable === false))
      && (!q || [r.poNumber, r.orderName, r.clientName].some((v) => v.toLowerCase().includes(q))));
    const val = (r: CostingOverviewRow) => r[sort.key];
    return [...filtered].sort((a, b) => {
      const x = val(a), y = val(b);
      // Missing figures sink to the bottom whichever way the column is sorted.
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir;
    });
  }, [data, search, show, sort]);

  if (isLoading) return <Spinner label="Costing every order…" />;
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;
  if (!data) return null;
  const s = data.summary;

  const header = (key: SortKey, label: string, right = true) => (
    <th className={clsx('th cursor-pointer select-none whitespace-nowrap', right && 'text-right')}
      onClick={() => setSort((p) => ({ key, dir: p.key === key ? (p.dir === 1 ? -1 : 1) : -1 }))}>
      <span className="inline-flex items-center gap-1">{label}<ArrowUpDown className={clsx('h-3 w-3', sort.key === key ? 'text-accent-600' : 'text-ink-300')} /></span>
    </th>
  );

  return (
    <div className="space-y-5 p-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Costing</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Every order's actual cost against its selling price, as its own Costing tab computes it. Click a row to open the sheet.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Orders costed" value={<>{s.costed}<span className="text-base font-normal text-ink-400"> / {s.orders}</span></>}
          sub={s.waiting > 0 ? `${s.waiting} still waiting for a price, a shipment or a cost` : 'Every open order has a figure'} onClick={() => setShow('costed')} />
        <StatTile label="Total profit" tone={s.totalProfitUsd == null ? 'neutral' : s.totalProfitUsd >= 0 ? 'emerald' : 'red'}
          value={<Num value={s.totalProfitUsd} kind="money" places={0} fallback="Not yet" />} sub="Over the costed orders, at the shipped quantity" />
        <StatTile label="Total actual cost" value={<Num value={s.totalCostUsd} kind="money" places={0} fallback="Not yet" />} sub="Fabric, accessories, outside work and cut-and-make" />
        <StatTile label="Margin" tone={s.marginPct == null ? 'neutral' : s.marginPct >= 20 ? 'emerald' : s.marginPct > 0 ? 'amber' : 'red'}
          value={<Num value={s.marginPct} kind="percent" places={1} fallback="Not yet" />}
          sub={s.avgProfitPct == null ? 'Profit over revenue, weighted by order' : <>Weighted by revenue. Simple average of orders: <Num value={s.avgProfitPct} kind="percent" places={1} /></>} />
        <StatTile label="Losing money" tone={s.losing > 0 ? 'red' : 'neutral'} value={s.losing}
          sub={s.losing > 0 ? 'Orders whose actual cost exceeds the price' : 'No costed order is below cost'} onClick={() => setShow('losing')} />
      </div>

      <Card>
        <CardHeader
          title="By order"
          subtitle={`${rows.length} of ${data.rows.length} orders`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-md border border-ink-300 p-0.5">
                {([['all', 'All'], ['costed', 'Costed'], ['waiting', 'Waiting'], ['losing', 'Losing']] as Array<[Show, string]>).map(([k, l]) => (
                  <button key={k} onClick={() => setShow(k)} className={clsx('rounded px-2 py-0.5 text-xs', show === k ? 'bg-accent-600 text-white' : 'text-ink-600')}>{l}</button>
                ))}
              </div>
              <label className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="PO, order, client" className="input !w-48 !py-1 !pl-7 text-xs" />
              </label>
            </div>
          }
        />
        {rows.length === 0 ? <EmptyState title="No orders match" /> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  {header('poNumber', 'PO / Order', false)}
                  {header('clientName', 'Client', false)}
                  <th className="th">Status</th>
                  {header('orderQty', 'Ordered')}
                  <th className="th text-right">Shipped</th>
                  {header('sellPriceUsd', 'Price')}
                  {header('unitActualCostUsd', 'Cost / pc')}
                  {header('profitPerUnitUsd', 'Profit / pc')}
                  {header('profitPct', 'Margin')}
                  {header('totalCostUsd', 'Total cost')}
                  {header('totalProfitUsd', 'Total profit')}
                  <th className="th">Costing sheet</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr key={r.orderId} onClick={() => navigate(`/orders/${r.orderId}?tab=costing`)}
                    className={clsx('cursor-pointer hover:bg-accent-50/40', r.isProfitable === false && 'bg-red-50/40')}>
                    <td className="td">
                      <p className="font-mono text-xs font-semibold text-accent-700">{r.poNumber}</p>
                      <p className="max-w-[16rem] truncate text-xs text-ink-600">{r.orderName}</p>
                    </td>
                    <td className="td text-xs text-ink-700">{r.clientName}</td>
                    <td className="td"><StatusBadge status={r.status as OrderStatus} /></td>
                    <td className="td tnum text-right">{r.orderQty.toLocaleString()}</td>
                    <td className="td text-right"><Num value={r.shippedQty} fallback="—" /></td>
                    <td className="td text-right"><Num value={r.sellPriceUsd} kind="money" fallback="—" /></td>
                    <td className="td text-right"><Num value={r.unitActualCostUsd} kind="money" fallback="—" /></td>
                    <td className={clsx('td text-right font-medium', r.isProfitable === true && 'text-emerald-700', r.isProfitable === false && 'text-red-700')}>
                      <Num value={r.profitPerUnitUsd} kind="money" fallback="—" />
                    </td>
                    <td className={clsx('td text-right', r.isProfitable === true && 'text-emerald-700', r.isProfitable === false && 'text-red-700')}>
                      <Num value={r.profitPct} kind="percent" places={1} fallback="—" />
                    </td>
                    <td className="td text-right"><Num value={r.totalCostUsd} kind="money" places={0} fallback="—" /></td>
                    <td className="td text-right"><Num value={r.totalProfitUsd} kind="money" places={0} fallback="—" /></td>
                    <td className="td text-xs">
                      {r.profitPerUnitUsd != null
                        ? <span className="text-ink-600">{r.hasRecord ? (r.costingDate ? `Saved ${fmtDate(r.costingDate)}` : 'Saved') : 'Live from the order'}</span>
                        : <span className="italic text-amber-700" title={r.waitingFor ?? undefined}>{r.waitingFor ?? 'Waiting'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-500">
          Cost per piece and profit are at the shipped quantity, as on the sheet, so they appear once an order has shipped. {ORDER_STATUS_LABEL.SHIPPED} and {ORDER_STATUS_LABEL.COMPLETED} orders carry the final figures.
        </p>
      </Card>
    </div>
  );
}
