import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ComposedChart, Bar, Line, Legend, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea, Cell,
} from 'recharts';
import { ChevronLeft, ChevronRight, ChevronDown, ArrowRight, TrendingUp, TrendingDown, Minus, Check } from 'lucide-react';
import {
  fmtDate, fmtDateShort, fmtNumber, fmtPct,
  PRODUCTION_OPERATIONS, PRIMARY_OPERATION, periodRange, shiftDay, daysInRange, isDayKey,
  type ProductionOperation, type ProductivityDto, type ProductivityPeriod, type Trend, type DayRange, type FactoryOverview,
  type LabourSummary, type DeliverySummary, type RftSummary, type ProductivityDayLogDto,
} from '@opsflow/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, CardHeader, StatTile, Spinner, ErrorNote, EmptyState, useToast, clsx } from '../components/ui';
import { ComboSelect } from '../components/ComboSelect';

/**
 * Factory productivity — Phase 1.
 *
 * Everything on this screen is read from records that already exist on the
 * orders: production entries, quality audits and cutting records. There is no
 * new input here, and nothing is estimated. Where the records do not support a
 * figure the tile says so — "Not recorded" is a different fact from "0", and
 * the screen keeps the two apart everywhere.
 */

type Mode = ProductivityPeriod | 'custom';
const MODES: Array<{ key: Mode; label: string }> = [
  { key: 'day', label: 'Day' }, { key: 'week', label: 'Week' }, { key: 'month', label: 'Month' }, { key: 'custom', label: 'Custom' },
];

/** Today as the calendar day the user is looking at, not the UTC day. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function opLabel(op: string): string {
  return op.charAt(0) + op.slice(1).toLowerCase();
}

/** One colour per operation, so a stage reads the same in every chart. */
const OP_COLOR: Record<ProductionOperation, string> = {
  CUTTING: '#0ea5e9', PRINTING: '#a855f7', EMBROIDERY: '#ec4899', SEWING: '#2563eb', PACKING: '#16a34a',
};

export function ProductivityPage() {
  const [params, setParams] = useSearchParams();
  const today = localToday();

  const mode: Mode = (MODES.find((m) => m.key === params.get('mode'))?.key) ?? 'week';
  const anchor = isDayKey(params.get('anchor')) ? params.get('anchor')! : today;
  const primary: ProductionOperation =
    (PRODUCTION_OPERATIONS.find((o) => o === params.get('primary'))) ?? PRIMARY_OPERATION;

  const range: DayRange = useMemo(() => {
    if (mode === 'custom') {
      const from = params.get('from'), to = params.get('to');
      if (isDayKey(from) && isDayKey(to) && from <= to) return { from, to };
      return periodRange('week', anchor);
    }
    return periodRange(mode, anchor);
  }, [mode, anchor, params]);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) next.delete(k); else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const step = (direction: 1 | -1) => {
    if (mode === 'custom') {
      const n = daysInRange(range);
      update({ from: shiftDay(range.from, direction * n), to: shiftDay(range.to, direction * n) });
      return;
    }
    const d = new Date(`${anchor}T00:00:00Z`);
    if (mode === 'day') update({ anchor: shiftDay(anchor, direction) });
    else if (mode === 'week') update({ anchor: shiftDay(anchor, direction * 7) });
    else update({ anchor: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + direction, 1)).toISOString().slice(0, 10) });
  };

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['productivity', range.from, range.to, primary],
    queryFn: () => api.productivity.get({ from: range.from, to: range.to, primary }),
    refetchInterval: 120_000,
  });

  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Productivity</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            What the factory produced, from the records on each order. A day nobody logged is shown as not recorded, never as zero.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-ink-300 p-0.5">
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => update({
                mode: m.key,
                ...(m.key === 'custom' ? { from: range.from, to: range.to } : { from: null, to: null }),
              })}
              className={clsx('rounded px-2.5 py-1 text-xs font-medium', mode === m.key ? 'bg-accent-600 text-white' : 'text-ink-600 hover:bg-ink-50')}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button className="btn-secondary btn-sm" onClick={() => step(-1)} aria-label="Previous period"><ChevronLeft className="h-3.5 w-3.5" /></button>
          <span className="tnum min-w-[11rem] text-center text-sm font-medium text-ink-800">
            {range.from === range.to ? fmtDate(range.from) : `${fmtDateShort(range.from)} – ${fmtDate(range.to)}`}
          </span>
          <button className="btn-secondary btn-sm" onClick={() => step(1)} aria-label="Next period"><ChevronRight className="h-3.5 w-3.5" /></button>
          <button className="btn-secondary btn-sm" onClick={() => update({ anchor: null, from: null, to: null, mode: mode === 'custom' ? 'week' : mode })}>
            Today
          </button>
        </div>

        {mode === 'custom' && (
          <div className="flex items-center gap-1.5 text-xs text-ink-600">
            <input type="date" className="input !py-1 text-xs" value={range.from} max={range.to}
              onChange={(e) => isDayKey(e.target.value) && update({ from: e.target.value })} />
            <span>to</span>
            <input type="date" className="input !py-1 text-xs" value={range.to} min={range.from}
              onChange={(e) => isDayKey(e.target.value) && update({ to: e.target.value })} />
          </div>
        )}

        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-600">
          Primary operation
          <ComboSelect className="input !py-1 text-xs" value={primary}
            onChange={(e) => update({ primary: e.target.value === PRIMARY_OPERATION ? null : e.target.value })}>
            {PRODUCTION_OPERATIONS.map((o) => <option key={o} value={o}>{opLabel(o)}</option>)}
          </ComboSelect>
        </label>
      </div>

      {isLoading && <Spinner label="Adding up the production records…" />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data && <ProductivityBody data={data} />}
    </div>
  );
}

// ── Body ────────────────────────────────────────────────────────────────────

function ProductivityBody({ data }: { data: ProductivityDto }) {
  const out = data.output;
  const label = opLabel(data.primaryOperation);
  const [openDay, setOpenDay] = useState<string | null>(null);

  const recordsByDay = useMemo(() => {
    const m = new Map<string, ProductivityDto['records']>();
    for (const r of data.records) {
      const k = r.date.slice(0, 10);
      (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    return m;
  }, [data.records]);

  const nothingAtAll = out.recordedDays === 0 && !data.quality?.summary.auditCount && !data.fabric?.summary.recordCount;

  const visibleOps = PRODUCTION_OPERATIONS;

  return (
    <>
      <OverviewSection overview={data.overview} trend={data.overviewTrend} />
      <LabourSection labour={data.labour} trend={data.efficiencyTrend} dayLogs={data.dayLogs} orders={data.orders} />
      {(data.quality || data.delivery) && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {data.quality && <RftCard rft={data.quality.rft} />}
          {data.delivery && <DeliveryCard delivery={data.delivery} />}
        </div>
      )}
      <NotMeasuredCard labour={data.labour} />

      <div className="pt-1">
        <h2 className="text-base font-semibold text-ink-900">{label} in detail</h2>
        <p className="text-xs text-ink-500">The operation chosen as primary, with its own days, orders and records.</p>
      </div>

      {/* KPI tiles */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label={`${label} output`}
          tone="accent"
          value={out.primaryQty == null ? <Unrecorded /> : fmtNumber(out.primaryQty)}
          sub={out.primaryQty == null
            ? `No ${label.toLowerCase()} recorded on any day of this period`
            : <>pcs over {out.primaryRecordedDays} recorded day{out.primaryRecordedDays === 1 ? '' : 's'} <TrendNote trend={data.totalTrend} what="total" /></>}
        />
        <StatTile
          label="Per recorded production day"
          value={out.primaryAvgPerRecordedDay == null ? <Unrecorded /> : fmtNumber(out.primaryAvgPerRecordedDay)}
          sub={out.primaryAvgPerRecordedDay == null
            ? `Average ${label.toLowerCase()} on days with a ${label.toLowerCase()} record. Days without one are left out, not counted as zero.`
            : <>{label} pcs per day, averaged over the {out.primaryRecordedDays} day{out.primaryRecordedDays === 1 ? '' : 's'} with a {label.toLowerCase()} record <TrendNote trend={data.trend} what="rate" /></>}
        />
        <StatTile
          label="Best day"
          value={out.primaryPeakDay ? fmtNumber(out.primaryPeakDay.qty) : <Unrecorded />}
          sub={out.primaryPeakDay ? `pcs on ${fmtDate(out.primaryPeakDay.date)}` : `No ${label.toLowerCase()} recorded`}
        />
        <StatTile
          label="Days without a record"
          tone={out.unrecordedDays > 0 && out.recordedDays > 0 ? 'amber' : 'neutral'}
          value={fmtNumber(out.unrecordedDays)}
          sub={`of ${out.calendarDays} calendar day${out.calendarDays === 1 ? '' : 's'}. Unknown, not zero.`}
        />
        {data.quality && (
          <StatTile
            label="Defects per 100 inspected"
            tone={data.quality.summary.defectRatePct != null && data.quality.summary.defectRatePct > 2.5 ? 'red' : 'neutral'}
            value={data.quality.summary.defectRatePct == null ? <Unrecorded text={defectReason(data.quality.summary.reason)} /> : fmtNumber(data.quality.summary.defectRatePct, { places: 1 })}
            sub={defectSub(data.quality.summary)}
          />
        )}
        {data.fabric && (
          <StatTile
            label="Fabric per piece cut"
            value={data.fabric.summary.metresPerPiece == null ? <Unrecorded text={fabricReason(data.fabric.summary.reason)} /> : fmtNumber(data.fabric.summary.metresPerPiece, { places: 3, suffix: ' m' })}
            sub={fabricSub(data.fabric.summary)}
          />
        )}
      </div>

      {nothingAtAll ? (
        <Card>
          <EmptyState
            title="Nothing was recorded in this period"
            detail="No production entries, quality audits or cutting records carry a date in this range. Production is logged on each order's Production tab."
          />
        </Card>
      ) : (
        <>
          {/* Chart */}
          <Card>
            <CardHeader
              title={`${label} output by day`}
              subtitle={`Shaded days have no production record of any kind. ${out.recordedDays} of ${out.calendarDays} days recorded.`}
            />
            <div className="h-64 px-2 pb-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={out.days} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(d: string) => fmtDateShort(d)} tick={{ fontSize: 11, fill: '#65758d' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={{ fontSize: 11, fill: '#65758d' }} axisLine={false} tickLine={false} width={48} tickFormatter={(v: number) => v.toLocaleString()} />
                  <Tooltip
                    cursor={{ fill: '#f1f5f9' }}
                    content={({ active, payload }) => {
                      const d = active && payload && payload[0]?.payload as ProductivityDto['output']['days'][number] | undefined;
                      if (!d) return null;
                      return (
                        <div className="rounded-md border border-ink-200 bg-white px-3 py-2 text-xs shadow-panel">
                          <p className="font-medium text-ink-900">{fmtDate(d.date)}</p>
                          {!d.recorded ? <p className="italic text-ink-500">No production recorded</p> : (
                            <ul className="mt-1 space-y-0.5">
                              {PRODUCTION_OPERATIONS.filter((o) => d.byOperation[o] != null).map((o) => (
                                <li key={o} className={clsx('flex justify-between gap-4', o === data.primaryOperation && 'font-semibold')}>
                                  <span>{opLabel(o)}</span><span className="tnum">{fmtNumber(d.byOperation[o])}</span>
                                </li>
                              ))}
                              {d.primary == null && <li className="italic text-ink-500">{label} not recorded</li>}
                            </ul>
                          )}
                        </div>
                      );
                    }}
                  />
                  {out.days.filter((d) => !d.recorded).map((d) => (
                    <ReferenceArea key={d.date} x1={d.date} x2={d.date} fill="#e2e8f0" fillOpacity={0.6} strokeOpacity={0} />
                  ))}
                  <Bar dataKey="primary" radius={[3, 3, 0, 0]} maxBarSize={36} isAnimationActive={false}>
                    {out.days.map((d) => <Cell key={d.date} fill={d.recorded ? '#2563eb' : 'transparent'} />)}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            {/* By day */}
            <Card className="xl:col-span-2">
              <CardHeader title="By day" subtitle="Click a day to see which orders the output came from." />
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-ink-200 bg-ink-50">
                    <tr>
                      <th className="th">Date</th>
                      {visibleOps.map((o) => (
                        <th key={o} className={clsx('th text-right', o === data.primaryOperation && 'text-accent-700')}>{opLabel(o)}</th>
                      ))}
                      <th className="th text-right">Orders</th>
                      <th className="th" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {out.days.map((d) => {
                      const open = openDay === d.date;
                      const rows = recordsByDay.get(d.date) ?? [];
                      return (
                        <DayRow key={d.date} day={d} open={open} rows={rows} primary={data.primaryOperation} ops={visibleOps}
                          onToggle={() => setOpenDay(open ? null : d.date)} />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* By operation */}
            <Card>
              <CardHeader title="By operation" subtitle="Totals over the days each was recorded" />
              <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-ink-200 bg-ink-50">
                  <tr><th className="th">Operation</th><th className="th text-right">Pieces</th><th className="th text-right">Days</th><th className="th text-right">Avg/day</th></tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {out.byOperation.filter((o) => visibleOps.includes(o.operation)).map((o) => (
                    <tr key={o.operation} className={clsx(o.operation === data.primaryOperation && 'bg-accent-50/40')}>
                      <td className="td font-medium">{opLabel(o.operation)}</td>
                      <td className="td text-right"><Qty value={o.qty} /></td>
                      <td className="td tnum text-right">{o.recordedDays}</td>
                      <td className="td text-right"><Qty value={o.avgPerRecordedDay} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </Card>
          </div>

          {/* By order */}
          <Card>
            <CardHeader title="By order" subtitle={`${data.orders.length} order${data.orders.length === 1 ? '' : 's'} with a production record in this period`} />
            {data.orders.length === 0 ? <EmptyState title="No order recorded production in this period" /> : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-ink-200 bg-ink-50">
                    <tr>
                      <th className="th">PO</th><th className="th">Order</th><th className="th">Client</th><th className="th">Factory</th>
                      <th className="th text-right text-accent-700">{label}</th>
                      {visibleOps.filter((o) => o !== data.primaryOperation).map((o) => <th key={o} className="th text-right">{opLabel(o)}</th>)}
                      <th className="th text-right">Days</th><th className="th" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {data.orders.map((o) => (
                      <tr key={o.orderId} className="hover:bg-ink-50/60">
                        <td className="td font-medium"><Link to={`/orders/${o.orderId}?tab=production`} className="text-accent-700 hover:underline">{o.poNumber}</Link></td>
                        <td className="td">{o.orderName}</td>
                        <td className="td text-xs text-ink-600">{o.clientName}</td>
                        <td className="td text-xs text-ink-600">{o.factoryName ?? '—'}</td>
                        <td className="td text-right font-medium"><Qty value={o.primary} /></td>
                        {visibleOps.filter((op) => op !== data.primaryOperation).map((op) => (
                          <td key={op} className="td text-right"><Qty value={o.byOperation[op]} /></td>
                        ))}
                        <td className="td tnum text-right">{o.recordedDays}</td>
                        <td className="td text-right"><Link to={`/orders/${o.orderId}?tab=production`} className="btn-secondary btn-sm">Open <ArrowRight className="h-3 w-3" /></Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {data.quality && <QualityCard quality={data.quality} />}
            {data.fabric && <FabricCard fabric={data.fabric} />}
          </div>
        </>
      )}

      <Card>
        <CardHeader title="Not shown on this page" subtitle="Figures the records cannot support yet, rather than estimates" />
        <ul className="divide-y divide-ink-100 text-sm">
          <li className="px-4 py-2.5"><span className="font-medium text-ink-800">Marker efficiency by period.</span> <span className="text-ink-600">Markers are a plan with no date, so they cannot be placed in a day, week or month. Each order's Cutting &amp; Marker tab shows them.</span></li>
          <li className="px-4 py-2.5"><span className="font-medium text-ink-800">Output by line.</span> <span className="text-ink-600">The line on a production record is free text, so the same line can appear under several spellings. It is shown per order on the Production tab.</span></li>
        </ul>
      </Card>
    </>
  );
}

// ── Overall factory productivity ────────────────────────────────────────────
//
// Three separate things, never added together: unique garments (sewn),
// finished goods (packed) and pieces through each stage. A record is pieces
// through one operation and a garment passes through several, so a sum across
// stages would count one garment up to five times.

function OverviewSection({ overview: f, trend }: { overview: FactoryOverview; trend: Trend }) {
  const recordedStages = f.stages.filter((s) => s.recorded);
  const chartData = f.days.map((d) => ({ date: d.date, recorded: d.recorded, ...d.byOperation }));

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink-900">Overall factory productivity</h2>
        <p className="text-xs text-ink-500">
          Every production record in this period, across all orders. Stages are the same garments counted at each step, so they are shown side by side and never added together.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Garments sewn"
          tone="accent"
          value={f.garmentsSewn == null ? <Unrecorded /> : fmtNumber(f.garmentsSewn)}
          sub={f.garmentsSewn == null
            ? 'Unique output. No sewing recorded on any day of this period.'
            : <>unique garments made, over {f.sewnRecordedDays} day{f.sewnRecordedDays === 1 ? '' : 's'} with a sewing record <TrendNote trend={trend} what="rate" /></>}
        />
        <StatTile
          label="Garments packed"
          tone="emerald"
          value={f.garmentsPacked == null ? <Unrecorded /> : fmtNumber(f.garmentsPacked)}
          sub={f.garmentsPacked == null
            ? 'Finished goods. No packing recorded in this period.'
            : `finished goods, over ${f.packedRecordedDays} day${f.packedRecordedDays === 1 ? '' : 's'} with a packing record. The same garments as sewn, counted at the last stage.`}
        />
        <StatTile
          label="Days with a record"
          tone={f.unrecordedDays > 0 && f.recordedDays > 0 ? 'amber' : 'neutral'}
          value={<>{fmtNumber(f.recordedDays)}<span className="text-base font-normal text-ink-400"> / {f.calendarDays}</span></>}
          sub={f.unrecordedDays === 0
            ? 'Every day of the period has at least one production record.'
            : `${f.unrecordedDays} day${f.unrecordedDays === 1 ? '' : 's'} with no record of any operation. Unknown, not zero.`}
        />
        <StatTile
          label="Orders active"
          value={fmtNumber(f.activeOrders)}
          sub={`${fmtNumber(f.recordCount)} production record${f.recordCount === 1 ? '' : 's'} across ${f.operationsRecorded.length} of ${f.stages.length} operations`}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader
            title="Daily trend by stage"
            subtitle={recordedStages.length === 0
              ? 'No production record of any operation in this period.'
              : `One line per recorded operation. Shaded days have no record of any kind; a gap in a line is a day that operation was not recorded.`}
          />
          {recordedStages.length === 0 ? <EmptyState title="Nothing recorded in this period" /> : (
            <div className="h-64 px-2 pb-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(d: string) => fmtDateShort(d)} tick={{ fontSize: 11, fill: '#65758d' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={{ fontSize: 11, fill: '#65758d' }} axisLine={false} tickLine={false} width={48} tickFormatter={(v: number) => v.toLocaleString()} />
                  <Tooltip
                    cursor={{ stroke: '#cbd5e1' }}
                    content={({ active, payload }) => {
                      const d = active && payload && payload[0]?.payload as (typeof chartData)[number] | undefined;
                      if (!d) return null;
                      return (
                        <div className="rounded-md border border-ink-200 bg-white px-3 py-2 text-xs shadow-panel">
                          <p className="font-medium text-ink-900">{fmtDate(d.date)}</p>
                          {!d.recorded ? <p className="italic text-ink-500">No production recorded</p> : (
                            <ul className="mt-1 space-y-0.5">
                              {f.stages.filter((st) => d[st.operation] != null).map((st) => (
                                <li key={st.operation} className="flex justify-between gap-4">
                                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: OP_COLOR[st.operation] }} />{opLabel(st.operation)}</span>
                                  <span className="tnum">{fmtNumber(d[st.operation])}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v: string) => opLabel(v)} />
                  {f.days.filter((d) => !d.recorded).map((d) => (
                    <ReferenceArea key={d.date} x1={d.date} x2={d.date} fill="#e2e8f0" fillOpacity={0.6} strokeOpacity={0} />
                  ))}
                  {recordedStages.map((st) => (
                    <Line key={st.operation} type="monotone" dataKey={st.operation} stroke={OP_COLOR[st.operation]} strokeWidth={2}
                      dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader title="Pieces through each stage" subtitle="In manufacturing order. Not totalled: it is the same garment at each stage." />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr><th className="th">Stage</th><th className="th text-right">Pieces</th><th className="th text-right">Days</th><th className="th text-right">Avg/day</th><th className="th">Data</th></tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {f.stages.map((st) => (
                  <tr key={st.operation} className={clsx(!st.recorded && 'text-ink-400')}>
                    <td className="td font-medium">
                      <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: st.recorded ? OP_COLOR[st.operation] : '#cbd5e1' }} />
                      {opLabel(st.operation)}
                    </td>
                    <td className="td text-right"><Qty value={st.qty} /></td>
                    <td className="td tnum text-right">{st.recorded ? st.recordedDays : ''}</td>
                    <td className="td text-right"><Qty value={st.avgPerRecordedDay} /></td>
                    <td className="td text-xs">
                      {st.recorded
                        ? <span className="chip bg-emerald-50 text-emerald-700 ring-emerald-500/20">Recorded</span>
                        : <span className="chip bg-ink-100 text-ink-500 ring-ink-500/20">Not recorded</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-500">
            Cutting counts panels, printing and embroidery count decorated panels, sewing counts garments made, packing counts garments boxed. Adding the rows would count one garment several times, so there is no total row.
          </p>
        </Card>
      </div>

    </section>
  );
}

// ── Labour: efficiency, SAH, pieces per operator and machine ────────────────
//
// The sewing floor's standard arithmetic: produced minutes (pieces × SAM)
// over attended minutes (operators + helpers, × minutes worked). The day log
// is the denominator, entered here one row per day; the SAM lives on each
// order's Details tab.

function LabourSection({ labour: l, trend, dayLogs, orders }: {
  labour: LabourSummary; trend: Trend; dayLogs: ProductivityDayLogDto[]; orders: ProductivityDto['orders'];
}) {
  const noSam = orders.filter((o) => l.ordersWithoutSam.includes(o.orderId));
  const effTone = l.efficiencyPct == null ? 'neutral' : l.efficiencyPct >= 75 ? 'emerald' : l.efficiencyPct >= 50 ? 'amber' : 'red';
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink-900">Labour productivity</h2>
        <p className="text-xs text-ink-500">
          Line efficiency is the standard minutes the floor produced (garments sewn × each style's SAM) over the minutes it attended (operators + helpers × minutes worked), lost time not deducted. A day counts only when its sheet is filled and every garment sewn has a SAM.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Line efficiency"
          tone={effTone}
          value={l.efficiencyPct == null ? <Unrecorded text={labourReason(l)} /> : fmtPct(l.efficiencyPct, 1)}
          sub={l.efficiencyPct == null ? labourSub(l) : <>
            {fmtNumber(l.producedMinutes)} produced min over {fmtNumber(l.attendedMinutes)} attended, {l.countedDays} of {l.sewingDays} sewing day{l.sewingDays === 1 ? '' : 's'} counted. Trade benchmark 75%.
            <TrendNote trend={trend} what="rate" unit="pct" />
          </>}
        />
        <StatTile
          label="Standard hours produced"
          value={l.producedSah == null ? <Unrecorded /> : fmtNumber(l.producedSah, { places: 1 })}
          sub={l.producedSah == null ? 'SAH: garments sewn × SAM ÷ 60, on the counted days' : `SAH on the ${l.countedDays} counted day${l.countedDays === 1 ? '' : 's'}, with ${fmtNumber(l.avgManpower, { places: 1 })} people on average`}
        />
        <StatTile
          label="Garments per operator-day"
          value={l.piecesPerOperatorDay == null ? <Unrecorded /> : fmtNumber(l.piecesPerOperatorDay, { places: 1 })}
          sub={l.piecesPerOperatorDay == null ? 'Needs the operator count on a day with sewing' : 'Garments sewn ÷ operator-days, on days with both. Needs no SAM.'}
        />
        <StatTile
          label="Garments per machine-day"
          value={l.piecesPerMachineDay == null ? <Unrecorded /> : fmtNumber(l.piecesPerMachineDay, { places: 1 })}
          sub={l.piecesPerMachineDay == null ? 'Needs the machines running on a day with sewing' : 'Garments sewn ÷ machine-days, on days with both.'}
        />
      </div>

      {noSam.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50/60 px-4 py-2.5 text-xs text-amber-800">
          <span className="font-medium">No SAM on {noSam.length} order{noSam.length === 1 ? '' : 's'} that sewed in this period:</span>{' '}
          {noSam.map((o, i) => (
            <span key={o.orderId}>{i > 0 && ', '}<Link to={`/orders/${o.orderId}`} className="underline">{o.poNumber}</Link></span>
          ))}
          . Line efficiency needs each order's standard minutes per garment, which is no longer entered on Order Details, so those days are not counted.
        </div>
      )}

      <DayLogSheet labour={l} dayLogs={dayLogs} />
    </section>
  );
}

function labourReason(l: LabourSummary): string {
  return l.reason === 'NO_SEWING' ? 'No sewing' : l.reason === 'NO_LOGS' ? 'No day sheet' : 'Incomplete';
}
function labourSub(l: LabourSummary): string {
  if (l.reason === 'NO_SEWING') return 'No sewing recorded in this period, so there is no output to measure.';
  if (l.reason === 'NO_LOGS') return `${l.sewingDays} sewing day${l.sewingDays === 1 ? '' : 's'}, none with a day sheet. Fill in the people and minutes below.`;
  const parts: string[] = [];
  if (l.excluded.noLog) parts.push(`${l.excluded.noLog} without a sheet`);
  if (l.excluded.logIncomplete) parts.push(`${l.excluded.logIncomplete} with operators or minutes missing`);
  if (l.excluded.samMissing) parts.push(`${l.excluded.samMissing} with garments that have no SAM`);
  return `${l.sewingDays} sewing day${l.sewingDays === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}

/** The daily sheet: one row per day of the period, saved a row at a time. */
function DayLogSheet({ labour, dayLogs }: { labour: LabourSummary; dayLogs: ProductivityDayLogDto[] }) {
  const { can } = useAuth();
  const editable = can('production:write');
  const byDate = useMemo(() => new Map(dayLogs.map((d) => [d.date, d])), [dayLogs]);
  return (
    <Card>
      <CardHeader
        title="Factory day sheet"
        subtitle={editable
          ? 'Who was on the floor and for how long, one row per day. Output is not entered here: it comes from the production records.'
          : 'Who was on the floor and for how long. Recording production is needed to edit it.'}
      />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              <th className="th">Date</th>
              <th className="th text-right">Sewn</th>
              <th className="th text-right">Operators</th>
              <th className="th text-right">Helpers</th>
              <th className="th text-right">Minutes/person</th>
              <th className="th text-right">Machines</th>
              <th className="th text-right">Produced min</th>
              <th className="th text-right">Efficiency</th>
              <th className="th">Counted</th>
              {editable && <th className="th" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {labour.days.map((d) => (
              <DayLogRow key={d.date} day={d} log={byDate.get(d.date) ?? null} editable={editable} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function DayLogRow({ day, log, editable }: { day: LabourSummary['days'][number]; log: ProductivityDayLogDto | null; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const blank = { operators: '', helpers: '', workingMinutes: '', machinesRunning: '' };
  const fromLog = (l: ProductivityDayLogDto | null) => l ? {
    operators: l.operators == null ? '' : String(l.operators),
    helpers: l.helpers == null ? '' : String(l.helpers),
    workingMinutes: l.workingMinutes == null ? '' : String(l.workingMinutes),
    machinesRunning: l.machinesRunning == null ? '' : String(l.machinesRunning),
  } : blank;
  const [form, setForm] = useState(fromLog(log));
  useEffect(() => { setForm(fromLog(log)); }, [log]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(form) !== JSON.stringify(fromLog(log));
  const save = useMutation({
    mutationFn: () => api.productivity.saveDayLog(day.date, {
      operators: form.operators === '' ? null : Number(form.operators),
      helpers: form.helpers === '' ? null : Number(form.helpers),
      workingMinutes: form.workingMinutes === '' ? null : Number(form.workingMinutes),
      machinesRunning: form.machinesRunning === '' ? null : Number(form.machinesRunning),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['productivity'] }); toast.success(`Day sheet for ${fmtDate(day.date)} saved`); },
    onError: (e) => toast.error(e),
  });
  const cell = (k: keyof typeof form, max: number) => editable ? (
    <input type="number" min={0} max={max} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}
      className="input !w-20 !py-0.5 text-right text-xs" placeholder="—" />
  ) : <Qty value={log ? log[k] : null} />;
  const excludedWhy = day.excluded === 'NO_SEWING' ? 'no sewing' : day.excluded === 'NO_LOG' ? 'no sheet'
    : day.excluded === 'LOG_INCOMPLETE' ? 'operators or minutes missing' : day.excluded === 'SAM_MISSING' ? 'a garment has no SAM' : null;
  return (
    <tr className={clsx(day.sewn == null && 'text-ink-400', day.excluded == null && 'bg-emerald-50/30')}>
      <td className="td whitespace-nowrap font-medium">{fmtDate(day.date)}</td>
      <td className="td text-right"><Qty value={day.sewn} /></td>
      <td className="td text-right">{cell('operators', 5000)}</td>
      <td className="td text-right">{cell('helpers', 5000)}</td>
      <td className="td text-right">{cell('workingMinutes', 1440)}</td>
      <td className="td text-right">{cell('machinesRunning', 5000)}</td>
      <td className="td text-right"><Qty value={day.producedMinutes} /></td>
      <td className="td text-right font-medium"><Qty value={day.efficiencyPct} places={1} suffix="%" /></td>
      <td className="td text-xs">
        {day.excluded == null
          ? <span className="chip bg-emerald-50 text-emerald-700 ring-emerald-500/20">Counted</span>
          : <span className="text-ink-400">{excludedWhy}</span>}
      </td>
      {editable && (
        <td className="td text-right">
          <button className="btn-secondary btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            <Check className="h-3 w-3" /> Save
          </button>
        </td>
      )}
    </tr>
  );
}

function RftCard({ rft }: { rft: RftSummary }) {
  return (
    <Card>
      <CardHeader title="Right first time" subtitle="Audits that passed on their first inspection, over first inspections decided. Re-inspections are the consequence of a fail, so they are neither." />
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <StatTile
          label="Right first time"
          tone={rft.rftPct == null ? 'neutral' : rft.rftPct >= 98 ? 'emerald' : rft.rftPct >= 90 ? 'amber' : 'red'}
          value={rft.rftPct == null ? <Unrecorded text={rft.reason === 'NO_AUDITS' ? 'No audits' : 'None decided'} /> : fmtPct(rft.rftPct, 1)}
          sub={rft.rftPct == null ? 'No first inspection was decided in this period' : `${rft.passedFirstTime} of ${rft.firstInspections} first inspections passed. Trade benchmark 98%.`}
        />
        <StatTile label="Failed first time" tone={rft.failedFirstTime > 0 ? 'red' : 'neutral'} value={fmtNumber(rft.failedFirstTime)} sub="Each one costs a rework and a re-inspection" />
        <StatTile label="Re-inspections" value={fmtNumber(rft.reinspections)} sub={`${rft.pending} audit${rft.pending === 1 ? '' : 's'} still pending`} />
      </div>
    </Card>
  );
}

function DeliveryCard({ delivery: d }: { delivery: DeliverySummary }) {
  return (
    <Card>
      <CardHeader title="Delivery" subtitle="Shipments that left in this period, against the date promised, and how much was cut for what was shipped." />
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <StatTile
          label="On-time delivery"
          tone={d.onTimePct == null ? 'neutral' : d.onTimePct >= 98 ? 'emerald' : d.onTimePct >= 90 ? 'amber' : 'red'}
          value={d.onTimePct == null ? <Unrecorded text={d.reason === 'NO_SHIPMENTS' ? 'No shipments' : 'No promises'} /> : fmtPct(d.onTimePct, 0)}
          sub={d.reason === 'NO_SHIPMENTS' ? 'No shipment has an actual shipping date in this period'
            : d.reason === 'NO_PROMISES' ? `${d.shipments} shipment${d.shipments === 1 ? '' : 's'}, none with a promised date to measure against`
            : `${d.onTime} on time, ${d.late} late${d.noPromise ? `, ${d.noPromise} with no promised date` : ''}. Trade benchmark 98%.`}
        />
        <StatTile label="Pieces shipped" value={fmtNumber(d.piecesShipped)} sub={`in ${d.shipments} shipment${d.shipments === 1 ? '' : 's'}`} />
        <StatTile
          label="Cut-to-ship ratio"
          tone={d.cutToShipRatio == null ? 'neutral' : d.cutToShipRatio <= 1.02 ? 'emerald' : d.cutToShipRatio <= 1.05 ? 'amber' : 'red'}
          value={d.cutToShipRatio == null ? <Unrecorded /> : fmtNumber(d.cutToShipRatio, { places: 3 })}
          sub={d.cutToShipRatio == null ? 'Needs a cut figure and shipped pieces for an order shipped in this period'
            : `Pieces cut ÷ pieces shipped to date, over ${d.cutToShipOrders} order${d.cutToShipOrders === 1 ? '' : 's'}${d.cutToShipExcluded ? `, ${d.cutToShipExcluded} without a cut figure` : ''}. 1.000 is perfect; a part-shipped order reads high until it ships out.`}
        />
      </div>
    </Card>
  );
}

function NotMeasuredCard({ labour }: { labour: LabourSummary }) {
  return (
    <Card>
      <CardHeader title="Not measured yet" subtitle="Figures the records cannot support, and what each would need" />
      <ul className="divide-y divide-ink-100 text-sm">
        <li className="px-4 py-2.5"><span className="font-medium text-ink-800">Labour cost per minute and per garment.</span> <span className="text-ink-600">Needs the floor's daily wage bill. Set against the attended minutes above it gives cost per minute; against produced minutes, the labour cost of each garment.</span></li>
        <li className="px-4 py-2.5"><span className="font-medium text-ink-800">Daily running cost and margin.</span> <span className="text-ink-600">Needs a daily factory cost. The daily cost on an order's costing sheet is a typed input for that one order, not a record of a day.</span></li>
        <li className="px-4 py-2.5"><span className="font-medium text-ink-800">Lost time and on-standard efficiency.</span> <span className="text-ink-600">Needs the minutes lost to breakdowns, waiting and line setting each day. The efficiency above is the overall figure, which the trade reports without deducting them.</span></li>
        {labour.reason != null && (
          <li className="px-4 py-2.5"><span className="font-medium text-ink-800">Line efficiency for this period.</span> <span className="text-ink-600">{labourSub(labour)}</span></li>
        )}
      </ul>
    </Card>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function DayRow({ day, rows, open, primary, ops, onToggle }: {
  day: ProductivityDto['output']['days'][number];
  rows: ProductivityDto['records'];
  open: boolean;
  primary: ProductionOperation;
  ops: readonly ProductionOperation[];
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={clsx('cursor-pointer hover:bg-ink-50/60', !day.recorded && 'bg-ink-50/40 text-ink-500', open && 'bg-accent-50/40')}
        onClick={day.recorded ? onToggle : undefined}
        title={day.recorded ? undefined : 'No production record of any kind on this day'}
      >
        <td className="td whitespace-nowrap font-medium">
          {fmtDate(day.date)}
          {!day.recorded && <span className="ml-2 text-2xs font-normal italic text-ink-400">not recorded</span>}
        </td>
        {ops.map((o) => (
          <td key={o} className={clsx('td text-right', o === primary && day.byOperation[o] != null && 'font-semibold')}>
            <Qty value={day.byOperation[o]} />
          </td>
        ))}
        <td className="td tnum text-right">{day.recorded ? day.orderCount : ''}</td>
        <td className="td text-right">
          {day.recorded && <ChevronDown className={clsx('inline h-3.5 w-3.5 text-ink-400 transition-transform', open && 'rotate-180')} />}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={ops.length + 3} className="bg-ink-50/60 px-4 py-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wider text-ink-500">
                  <th className="py-1 pr-3">PO</th><th className="py-1 pr-3">Order</th><th className="py-1 pr-3">Operation</th>
                  <th className="py-1 pr-3 text-right">Pieces</th><th className="py-1 pr-3">Line</th><th className="py-1 pr-3">Team</th><th />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1 pr-3 font-medium">{r.poNumber}</td>
                    <td className="py-1 pr-3">{r.orderName}</td>
                    <td className="py-1 pr-3"><span className="chip bg-ink-100 text-ink-700 ring-ink-500/20">{opLabel(r.operation)}</span></td>
                    <td className="py-1 pr-3 tnum text-right">{fmtNumber(r.qty)}</td>
                    <td className="py-1 pr-3">{r.line || '—'}</td>
                    <td className="py-1 pr-3">{r.team || '—'}</td>
                    <td className="py-1 text-right"><Link to={`/orders/${r.orderId}?tab=production`} className="text-accent-700 hover:underline">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

function QualityCard({ quality }: { quality: NonNullable<ProductivityDto['quality']> }) {
  const s = quality.summary;
  return (
    <Card>
      <CardHeader
        title="Quality audits in this period"
        subtitle={s.auditCount === 0 ? 'No audit carries an inspection date in this range.'
          : `${s.countedAudits} of ${s.auditCount} counted in the defect rate. ${s.failedCount} failed, ${s.pendingCount} pending.`}
      />
      {quality.audits.length > 0 && (
        <p className="border-b border-ink-100 px-4 py-2 text-xs text-ink-500">
          Defects are counted per fault, so a piece with two faults counts twice. The rate is defects per 100 pieces inspected, not a share of rejected pieces.
        </p>
      )}
      {quality.audits.length === 0 ? <EmptyState title="No audits in this period" /> : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr><th className="th">Date</th><th className="th">PO</th><th className="th">Type</th><th className="th text-right">Inspected</th><th className="th text-right">Defects</th><th className="th">Result</th><th className="th" /></tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {quality.audits.map((a) => (
                <tr key={a.id} className={clsx(!a.counted && 'text-ink-500')} title={a.counted ? undefined : 'Not counted: no sample size or defect count'}>
                  <td className="td whitespace-nowrap">{fmtDate(a.inspectionDate)}</td>
                  <td className="td font-medium">{a.poNumber}</td>
                  <td className="td text-xs">{opLabelWords(a.auditType)}{a.isReinspection && <span className="ml-1 text-ink-400">(re-inspection)</span>}</td>
                  <td className="td text-right"><Qty value={a.sampleSize} /></td>
                  <td className="td text-right"><Qty value={a.defectQty} /></td>
                  <td className="td">
                    <span className={clsx('chip', a.result === 'FAIL' ? 'bg-red-50 text-red-700 ring-red-500/20' : a.result === 'PASS' ? 'bg-emerald-50 text-emerald-700 ring-emerald-500/20' : 'bg-ink-100 text-ink-700 ring-ink-500/20')}>
                      {a.result}
                    </span>
                  </td>
                  <td className="td text-right"><Link to={`/orders/${a.orderId}?tab=quality`} className="text-accent-700 hover:underline">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function FabricCard({ fabric }: { fabric: NonNullable<ProductivityDto['fabric']> }) {
  const s = fabric.summary;
  return (
    <Card>
      <CardHeader
        title="Cutting records in this period"
        subtitle={s.recordCount === 0 ? 'No cutting record carries a cut date in this range.'
          : `${s.countedRecords} of ${s.recordCount} carry both the pieces cut and the metres used.`}
      />
      {fabric.records.length === 0 ? <EmptyState title="No dated cutting records in this period" /> : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr><th className="th">Cut date</th><th className="th">PO</th><th className="th text-right">Pieces cut</th><th className="th text-right">Fabric used</th><th className="th text-right">m/piece</th><th className="th" /></tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {fabric.records.map((r) => (
                <tr key={r.id} className={clsx(!r.counted && 'text-ink-500')} title={r.counted ? undefined : 'Not counted: pieces cut or metres used missing'}>
                  <td className="td whitespace-nowrap">{fmtDate(r.cutDate)}</td>
                  <td className="td font-medium">{r.poNumber}</td>
                  <td className="td text-right"><Qty value={r.actualCutQty} /></td>
                  <td className="td text-right"><Qty value={r.fabricUsedM} places={1} suffix=" m" /></td>
                  <td className="td text-right">
                    <Qty value={r.counted ? r.fabricUsedM! / r.actualCutQty! : null} places={3} />
                  </td>
                  <td className="td text-right"><Link to={`/orders/${r.orderId}?tab=cutting`} className="text-accent-700 hover:underline">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** A quantity cell: a number, or an explicit "not recorded" dash — never a zero that nobody entered. */
function Qty({ value, places = 0, suffix = '' }: { value: number | null | undefined; places?: number; suffix?: string }) {
  if (value == null || !Number.isFinite(value)) {
    return <span className="text-ink-400" title="Not recorded">—</span>;
  }
  return <span className="tnum">{fmtNumber(value, { places, suffix })}</span>;
}

function Unrecorded({ text = 'Not recorded' }: { text?: string }) {
  return <span className="text-base font-medium italic text-ink-400">{text}</span>;
}

function TrendNote({ trend, what, unit = 'number' }: { trend: Trend; what: 'total' | 'rate'; unit?: 'number' | 'pct' }) {
  if (trend.changePct == null) {
    const why = trend.reason === 'NO_PREVIOUS' ? 'nothing recorded in the period before'
      : trend.reason === 'PREVIOUS_ZERO' ? 'the period before recorded zero'
      : null;
    return why ? <span className="block text-ink-400">No comparison: {why}.</span> : null;
  }
  const up = trend.changePct > 0, flat = Math.abs(trend.changePct) < 0.5;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  return (
    <span className={clsx('mt-0.5 flex items-center gap-1', flat ? 'text-ink-500' : up ? 'text-emerald-600' : 'text-red-600')}>
      <Icon className="h-3 w-3" />
      {flat ? 'Level with' : `${fmtPct(Math.abs(trend.changePct), 0)} ${up ? 'above' : 'below'}`} the previous period's {what}
      {' '}({unit === 'pct' ? fmtPct(trend.previous, 1) : fmtNumber(trend.previous)})
    </span>
  );
}

function defectReason(reason: NonNullable<ProductivityDto['quality']>['summary']['reason']): string {
  return reason === 'NO_AUDITS' ? 'No audits' : reason === 'NO_COUNTABLE_AUDITS' ? 'No sample sizes' : 'Not recorded';
}
function defectSub(s: NonNullable<ProductivityDto['quality']>['summary']): string {
  if (s.reason === 'NO_AUDITS') return 'No quality audit has an inspection date in this period';
  if (s.reason === 'NO_COUNTABLE_AUDITS') return `${s.auditCount} audit${s.auditCount === 1 ? '' : 's'}, none with a sample size to count`;
  return `${fmtNumber(s.defectQty)} defects found in ${fmtNumber(s.sampleQty)} pcs inspected across ${s.countedAudits} audit${s.countedAudits === 1 ? '' : 's'}`
    + (s.excludedAudits > 0 ? `, ${s.excludedAudits} excluded` : '') + '. Not a share of rejected pieces.';
}
function fabricReason(reason: NonNullable<ProductivityDto['fabric']>['summary']['reason']): string {
  return reason === 'NO_RECORDS' ? 'No cutting' : reason === 'NO_COUNTABLE_RECORDS' ? 'Incomplete records' : 'Not recorded';
}
function fabricSub(s: NonNullable<ProductivityDto['fabric']>['summary']): string {
  if (s.reason === 'NO_RECORDS') return 'No cutting record has a cut date in this period';
  if (s.reason === 'NO_COUNTABLE_RECORDS') return `${s.recordCount} record${s.recordCount === 1 ? '' : 's'}, none with both pieces and metres`;
  return `${fmtNumber(s.fabricUsedM, { places: 1 })} m over ${fmtNumber(s.piecesCut)} pcs in ${s.countedRecords} record${s.countedRecords === 1 ? '' : 's'}`
    + (s.excludedRecords > 0 ? `, ${s.excludedRecords} excluded` : '');
}

/** FINAL_AUDIT → "Final audit". */
function opLabelWords(value: string): string {
  const words = value.toLowerCase().split('_');
  return (words[0] ?? '').charAt(0).toUpperCase() + (words[0] ?? '').slice(1) + (words.length > 1 ? ' ' + words.slice(1).join(' ') : '');
}
