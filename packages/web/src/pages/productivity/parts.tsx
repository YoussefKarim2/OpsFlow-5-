/**
 * The Productivity page's analysis charts and its editable production records.
 *
 * The charts read only what the page already has: production records, the day
 * sheet and the per-order totals. A day nobody recorded is left out of an
 * average rather than counted as zero, as everywhere else on the page.
 *
 * The records are the same production entries each order's Production tab
 * keeps; adding, correcting or removing one here is the same change made
 * there, through the same endpoints and the same checks.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { Pencil, Plus, Trash2, Check, X } from 'lucide-react';
import {
  fmtDate, fmtDateShort, fmtNumber, PRODUCTION_OPERATIONS,
  type ProductionOperation, type ProductivityDto,
} from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Card, CardHeader, EmptyState, StatTile, useToast, clsx } from '../../components/ui';
import { ComboSelect } from '../../components/ComboSelect';

export function opLabel(op: string): string {
  return op.charAt(0) + op.slice(1).toLowerCase();
}

/** One colour per operation, so a stage reads the same in every chart. */
export const OP_COLOR: Record<ProductionOperation, string> = {
  CUTTING: '#0ea5e9', PRINTING: '#a855f7', EMBROIDERY: '#ec4899', SEWING: '#2563eb', PACKING: '#16a34a',
};

const AXIS = { fontSize: 11, fill: '#65758d' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ChartCard({ title, subtitle, empty, children, className }: {
  title: string; subtitle: string; empty?: string | null; children: React.ReactNode; className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader title={title} subtitle={subtitle} />
      {empty ? <EmptyState title={empty} /> : <div className="h-60 px-2 pb-3">{children}</div>}
    </Card>
  );
}

function ChartTip({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-md border border-ink-200 bg-white px-3 py-2 text-xs shadow-panel">
      <p className="font-medium text-ink-900">{title}</p>
      {rows.map(([k, v]) => (
        <p key={k} className="flex justify-between gap-4 text-ink-700"><span>{k}</span><span className="tnum font-medium">{v}</span></p>
      ))}
    </div>
  );
}

// ── Analysis ────────────────────────────────────────────────────────────────

export function AnalysisCharts({ data }: { data: ProductivityDto }) {
  const f = data.overview;

  const sewnDays = useMemo(
    () => f.days.map((d) => ({ date: d.date, sewn: d.byOperation.SEWING ?? null })),
    [f.days],
  );
  const recorded = sewnDays.filter((d) => d.sewn != null) as Array<{ date: string; sewn: number }>;
  const average = recorded.length ? recorded.reduce((a, d) => a + d.sewn, 0) / recorded.length : null;
  const best = recorded.reduce<{ date: string; sewn: number } | null>((b, d) => (!b || d.sewn > b.sewn ? d : b), null);
  const worst = recorded.reduce<{ date: string; sewn: number } | null>((b, d) => (!b || d.sewn < b.sewn ? d : b), null);

  // Garments per operator, on the days the day sheet has operators and sewing.
  const perWorker = useMemo(() => {
    const logs = new Map(data.dayLogs.map((l) => [l.date.slice(0, 10), l]));
    return sewnDays
      .map((d) => {
        const ops = logs.get(d.date)?.operators;
        return { date: d.date, value: d.sewn != null && ops ? d.sewn / ops : null, operators: ops ?? null };
      })
      .filter((d) => d.value != null) as Array<{ date: string; value: number; operators: number }>;
  }, [data.dayLogs, sewnDays]);

  const topOrders = useMemo(
    () => data.orders
      .map((o) => ({ po: o.poNumber, name: o.orderName, sewn: o.byOperation.SEWING ?? 0 }))
      .filter((o) => o.sewn > 0)
      .sort((a, b) => b.sewn - a.sewn)
      .slice(0, 8),
    [data.orders],
  );

  const stages = f.stages.map((s) => ({ op: s.operation, label: opLabel(s.operation), qty: s.qty ?? 0, recorded: s.recorded }));

  const byWeekday = useMemo(() => {
    const sums = WEEKDAYS.map(() => ({ total: 0, days: 0 }));
    for (const d of recorded) {
      const w = new Date(`${d.date}T00:00:00Z`).getUTCDay();
      sums[w]!.total += d.sewn; sums[w]!.days += 1;
    }
    return WEEKDAYS.map((name, i) => ({ name, avg: sums[i]!.days ? sums[i]!.total / sums[i]!.days : 0, days: sums[i]!.days }));
  }, [recorded]);

  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Average sewn per day" value={average == null ? '—' : fmtNumber(average)} sub={`over the ${recorded.length} day${recorded.length === 1 ? '' : 's'} with sewing`} />
        <StatTile label="Best day" tone="emerald" value={best ? fmtNumber(best.sewn) : '—'} sub={best ? fmtDate(best.date) : 'No sewing recorded'} />
        <StatTile label="Slowest day" tone={worst && average && worst.sewn < average * 0.7 ? 'amber' : 'neutral'} value={worst ? fmtNumber(worst.sewn) : '—'} sub={worst ? fmtDate(worst.date) : 'No sewing recorded'} />
        <StatTile
          label="Per worker per day"
          value={data.labour.piecesPerOperatorDay == null ? '—' : fmtNumber(data.labour.piecesPerOperatorDay, { places: 1 })}
          sub={data.labour.piecesPerOperatorDay == null ? 'Fill in the day sheet on the Workers tab' : 'garments sewn per operator'}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <ChartCard
          title="Garments sewn per day"
          subtitle={average == null ? 'Sewing recorded each day' : `The dashed line is the average, ${fmtNumber(average)} a day.`}
          empty={recorded.length === 0 ? 'No sewing recorded in this period' : null}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={sewnDays} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(d: string) => fmtDateShort(d)} tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} width={48} tickFormatter={(v: number) => v.toLocaleString()} />
              <Tooltip cursor={{ fill: '#f1f5f9' }} content={({ active, payload }) => {
                const d = active && payload?.[0]?.payload as (typeof sewnDays)[number] | undefined;
                return d ? <ChartTip title={fmtDate(d.date)} rows={[['Sewn', d.sewn == null ? 'not recorded' : fmtNumber(d.sewn)]]} /> : null;
              }} />
              {average != null && <ReferenceLine y={average} stroke="#64748b" strokeDasharray="4 4" />}
              <Bar dataKey="sewn" radius={[3, 3, 0, 0]} maxBarSize={36} isAnimationActive={false}>
                {sewnDays.map((d) => (
                  <Cell key={d.date} fill={d.sewn != null && average != null && d.sewn < average * 0.7 ? '#f59e0b' : OP_COLOR.SEWING} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Garments per worker per day"
          subtitle="Garments sewn ÷ operators on the day sheet. Higher is better."
          empty={perWorker.length === 0 ? 'Fill in the operators on the Workers tab to see this' : null}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={perWorker} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(d: string) => fmtDateShort(d)} tick={AXIS} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} width={40} />
              <Tooltip content={({ active, payload }) => {
                const d = active && payload?.[0]?.payload as (typeof perWorker)[number] | undefined;
                return d ? <ChartTip title={fmtDate(d.date)} rows={[['Per worker', fmtNumber(d.value, { places: 1 })], ['Operators', fmtNumber(d.operators)]]} /> : null;
              }} />
              <Line type="monotone" dataKey="value" stroke="#0f766e" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Orders that sewed the most"
          subtitle="Garments sewn in this period, top 8 orders."
          empty={topOrders.length === 0 ? 'No order sewed in this period' : null}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topOrders} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
              <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v: number) => v.toLocaleString()} />
              <YAxis type="category" dataKey="po" tick={AXIS} axisLine={false} tickLine={false} width={96} />
              <Tooltip cursor={{ fill: '#f1f5f9' }} content={({ active, payload }) => {
                const d = active && payload?.[0]?.payload as (typeof topOrders)[number] | undefined;
                return d ? <ChartTip title={`${d.po} · ${d.name}`} rows={[['Sewn', fmtNumber(d.sewn)]]} /> : null;
              }} />
              <Bar dataKey="sewn" fill={OP_COLOR.SEWING} radius={[0, 3, 3, 0]} maxBarSize={22} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Pieces at each stage"
          subtitle="From cutting to packing. A gap between two stages is work waiting between them."
          empty={stages.every((s) => !s.recorded) ? 'Nothing recorded in this period' : null}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stages} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} width={48} tickFormatter={(v: number) => v.toLocaleString()} />
              <Tooltip cursor={{ fill: '#f1f5f9' }} content={({ active, payload }) => {
                const d = active && payload?.[0]?.payload as (typeof stages)[number] | undefined;
                return d ? <ChartTip title={d.label} rows={[['Pieces', d.recorded ? fmtNumber(d.qty) : 'not recorded']]} /> : null;
              }} />
              <Bar dataKey="qty" radius={[3, 3, 0, 0]} maxBarSize={48} isAnimationActive={false}>
                {stages.map((s) => <Cell key={s.op} fill={OP_COLOR[s.op]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          className="xl:col-span-2"
          title="Busiest days of the week"
          subtitle="Average garments sewn on each weekday, counting only days with sewing."
          empty={recorded.length === 0 ? 'No sewing recorded in this period' : null}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byWeekday} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="name" tick={AXIS} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} width={48} tickFormatter={(v: number) => v.toLocaleString()} />
              <Tooltip cursor={{ fill: '#f1f5f9' }} content={({ active, payload }) => {
                const d = active && payload?.[0]?.payload as (typeof byWeekday)[number] | undefined;
                return d ? <ChartTip title={d.name} rows={[['Average sewn', d.days ? fmtNumber(d.avg) : 'no sewing'], ['Days', String(d.days)]]} /> : null;
              }} />
              <Bar dataKey="avg" fill="#6366f1" radius={[3, 3, 0, 0]} maxBarSize={48} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </section>
  );
}

// ── Records: add, correct, remove ───────────────────────────────────────────

interface RecordDraft { date: string; operation: ProductionOperation; qty: string; line: string; team: string }

/**
 * Zero is a real answer — the line ran and made nothing — and the shared
 * production calc counts it as a day worked, so it is accepted here as on the
 * order's own tab. Only blanks, negatives and fractions are refused.
 */
const isPieceCount = (v: string): boolean => v.trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 0;
const PIECES_RULE = 'Pieces must be a whole number, 0 or more.';

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

export function ProductionRecords({ data, defaultDate }: { data: ProductivityDto; defaultDate: string }) {
  const { can } = useAuth();
  const editable = can('production:write');
  const qc = useQueryClient();
  const toast = useToast();
  // Everything that reads the order's production: its tab, its step rail and
  // the order itself, as well as this page.
  const refresh = (orderId: string) => {
    void qc.invalidateQueries({ queryKey: ['productivity'] });
    void qc.invalidateQueries({ queryKey: ['order', orderId] });
    void qc.invalidateQueries({ queryKey: ['production', orderId] });
    void qc.invalidateQueries({ queryKey: ['order-steps', orderId] });
  };

  const [adding, setAdding] = useState(false);
  const [orderId, setOrderId] = useState('');
  const [draft, setDraft] = useState<RecordDraft>({ date: defaultDate, operation: 'SEWING', qty: '', line: '', team: '' });
  // Every order, not the first page: the list is sorted by due date, so a
  // current PO could fall past the first hundred.
  const orders = useQuery({
    queryKey: ['orders', 'for-production'],
    queryFn: async () => {
      const all: Awaited<ReturnType<typeof api.orders.list>>['data'] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await api.orders.list({ pageSize: 100, page });
        all.push(...res.data);
        if (page >= res.totalPages) break;
      }
      return { data: all };
    },
    enabled: adding,
  });
  const create = useMutation({
    mutationFn: () => {
      const qty = Number(draft.qty);
      if (!orderId) throw new Error('Choose the order.');
      if (!isPieceCount(draft.qty)) throw new Error(PIECES_RULE);
      return api.production.record(orderId, {
        date: draft.date, operation: draft.operation, qty,
        line: draft.line.trim() || undefined, team: draft.team.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast.success('Production recorded');
      refresh(orderId);
      setDraft((d) => ({ ...d, qty: '' }));
    },
    onError: (e) => toast.error(errorText(e, 'Could not record it.')),
  });

  const rows = [...data.records].sort((a, b) => b.date.localeCompare(a.date) || a.poNumber.localeCompare(b.poNumber));

  return (
    <Card>
      <div className="card-header flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">Production records</h3>
          <p className="text-xs text-ink-500">
            {rows.length} record{rows.length === 1 ? '' : 's'} in this period.
            {editable ? ' Add, correct or remove one here; it changes the order too.' : ''}
          </p>
        </div>
        {editable && !adding && (
          <button className="btn-primary btn-sm" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> Add record</button>
        )}
      </div>

      {editable && adding && (
        <form
          className="flex flex-wrap items-end gap-2 border-b border-ink-100 bg-ink-50/50 px-4 py-3"
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
        >
          <label className="flex flex-col text-xs text-ink-600">Order
            <ComboSelect aria-label="Order" className="input mt-0.5 !py-1 text-sm" value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="Type a PO…">
              <option value="">Choose…</option>
              {(orders.data?.data ?? []).map((o) => <option key={o.id} value={o.id}>{`${o.poNumber} · ${o.orderName}`}</option>)}
            </ComboSelect>
          </label>
          <RecordFields draft={draft} onChange={setDraft} />
          <button type="submit" className="btn-primary btn-sm" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setAdding(false)}>Close</button>
        </form>
      )}

      {rows.length === 0 ? (
        <EmptyState title="No production recorded in this period" detail={editable ? 'Use Add record to enter what was made.' : undefined} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Date</th><th className="th">PO</th><th className="th">Order</th><th className="th">Stage</th>
                <th className="th text-right">Pieces</th><th className="th">Line</th><th className="th">Team</th>
                {editable && <th className="th" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((r) => <RecordRow key={r.id} record={r} editable={editable} onChanged={() => refresh(r.orderId)} />)}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RecordFields({ draft, onChange }: { draft: RecordDraft; onChange: (d: RecordDraft) => void }) {
  return (
    <>
      <label className="flex flex-col text-xs text-ink-600">Date
        <input type="date" className="input mt-0.5 !py-1 text-sm" value={draft.date} onChange={(e) => onChange({ ...draft, date: e.target.value })} />
      </label>
      <label className="flex flex-col text-xs text-ink-600">Stage
        <ComboSelect aria-label="Stage" className="input mt-0.5 !py-1 text-sm" value={draft.operation}
          onChange={(e) => onChange({ ...draft, operation: e.target.value as ProductionOperation })}>
          {PRODUCTION_OPERATIONS.map((o) => <option key={o} value={o}>{opLabel(o)}</option>)}
        </ComboSelect>
      </label>
      <label className="flex flex-col text-xs text-ink-600">Pieces
        <input type="number" min={0} step={1} className="input mt-0.5 !w-24 !py-1 text-right text-sm" value={draft.qty}
          onChange={(e) => onChange({ ...draft, qty: e.target.value })} />
      </label>
      <label className="flex flex-col text-xs text-ink-600">Line
        <input className="input mt-0.5 !w-24 !py-1 text-sm" value={draft.line} onChange={(e) => onChange({ ...draft, line: e.target.value })} />
      </label>
      <label className="flex flex-col text-xs text-ink-600">Team
        <input className="input mt-0.5 !w-24 !py-1 text-sm" value={draft.team} onChange={(e) => onChange({ ...draft, team: e.target.value })} />
      </label>
    </>
  );
}

function RecordRow({ record: r, editable, onChanged }: {
  record: ProductivityDto['records'][number]; editable: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const initial: RecordDraft = { date: r.date.slice(0, 10), operation: r.operation, qty: String(r.qty), line: r.line ?? '', team: r.team ?? '' };
  const [draft, setDraft] = useState<RecordDraft>(initial);

  const save = useMutation({
    mutationFn: () => {
      const qty = Number(draft.qty);
      if (!isPieceCount(draft.qty)) throw new Error(PIECES_RULE);
      return api.production.update(r.id, {
        date: draft.date, operation: draft.operation, qty, line: draft.line.trim() || null, team: draft.team.trim() || null,
      });
    },
    onSuccess: () => { toast.success('Record corrected'); setEditing(false); onChanged(); },
    onError: (e) => toast.error(errorText(e, 'Could not save it.')),
  });
  const remove = useMutation({
    mutationFn: () => api.production.remove(r.id),
    onSuccess: () => { toast.success('Record removed'); onChanged(); },
    onError: (e) => toast.error(errorText(e, 'Could not remove it.')),
  });

  if (editing) {
    return (
      <tr className="bg-accent-50/40">
        <td colSpan={8} className="px-4 py-2">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <span className="self-center text-sm font-medium text-ink-800">{r.poNumber}</span>
            <RecordFields draft={draft} onChange={setDraft} />
            <button type="submit" className="btn-primary btn-sm" disabled={save.isPending}><Check className="h-3.5 w-3.5" /> {save.isPending ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { setDraft(initial); setEditing(false); }}><X className="h-3.5 w-3.5" /> Cancel</button>
          </form>
        </td>
      </tr>
    );
  }
  return (
    <tr className="hover:bg-ink-50/60">
      <td className="td whitespace-nowrap">{fmtDate(r.date)}</td>
      <td className="td font-medium"><Link to={`/orders/${r.orderId}?tab=production`} className="text-accent-700 hover:underline">{r.poNumber}</Link></td>
      <td className="td">{r.orderName}</td>
      <td className="td"><span className="chip bg-ink-100 text-ink-700 ring-ink-500/20">{opLabel(r.operation)}</span></td>
      <td className="td tnum text-right font-medium">{fmtNumber(r.qty)}</td>
      <td className="td text-sm">{r.line || '—'}</td>
      <td className="td text-sm">{r.team || '—'}</td>
      {editable && (
        <td className="td whitespace-nowrap text-right">
          {confirming ? (
            <>
              <button className={clsx('btn-sm btn-danger')} onClick={() => remove.mutate()} disabled={remove.isPending}>Remove</button>{' '}
              <button className="btn-secondary btn-sm" onClick={() => setConfirming(false)}>Keep</button>
            </>
          ) : (
            <>
              <button className="btn-ghost btn-sm" onClick={() => setEditing(true)} title="Correct this record"><Pencil className="h-3.5 w-3.5" /> Edit</button>
              <button className="btn-ghost btn-sm text-red-600 hover:bg-red-50" onClick={() => setConfirming(true)} title="Remove this record"><Trash2 className="h-3.5 w-3.5" /></button>
            </>
          )}
        </td>
      )}
    </tr>
  );
}
