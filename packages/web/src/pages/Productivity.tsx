import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ComposedChart, Line, Legend, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea,
} from 'recharts';
import { ChevronLeft, ChevronRight, ArrowRight, TrendingUp, TrendingDown, Minus, Check } from 'lucide-react';
import {
  fmtDate, fmtDateShort, fmtNumber, fmtPct,
  PRODUCTION_OPERATIONS, PRIMARY_OPERATION, periodRange, shiftDay, daysInRange, isDayKey,
  type ProductionOperation, type ProductivityDto, type ProductivityPeriod, type Trend, type DayRange, type FactoryOverview,
  type LabourSummary, type DeliverySummary, type RftSummary, type ProductivityDayLogDto,
} from '@opsflow/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { localToday } from '../lib/local-today';
import { Card, CardHeader, StatTile, Spinner, ErrorNote, EmptyState, TabStrip, useToast, clsx } from '../components/ui';
import { ComboSelect } from '../components/ComboSelect';
import { AnalysisCharts, ProductionRecords, opLabel, OP_COLOR } from './productivity/parts';

/**
 * Factory productivity — four headline numbers, then Overview, Orders,
 * Workers and Quality & delivery tabs (simplified 2026-10-25).
 *
 * Phase 1.
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
            How much the factory made, from the production recorded on each order.
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

      </div>

      {isLoading && <Spinner label="Adding up the production records…" />}
      {error && <ErrorNote error={error} onRetry={refetch} />}
      {data && (
        <ProductivityBody
          data={data}
          view={VIEWS.find((v) => v.key === params.get('view'))?.key ?? 'overview'}
          onView={(v) => update({ view: v === 'overview' ? null : v })}
          primary={primary}
          onPrimary={(o) => update({ primary: o === PRIMARY_OPERATION ? null : o })}
        />
      )}
    </div>
  );
}

// ── Body ────────────────────────────────────────────────────────────────────

/** The page's four views, so each question has one place and the page is not one long scroll. */
const VIEWS = [
  { key: 'overview', label: 'Overview' },
  { key: 'records', label: 'Records' },
  { key: 'orders', label: 'Orders' },
  { key: 'workers', label: 'Workers' },
  { key: 'quality', label: 'Quality & delivery' },
] as const;
type View = (typeof VIEWS)[number]['key'];

function ProductivityBody({ data, view, onView, primary, onPrimary }: {
  data: ProductivityDto;
  view: View;
  onView: (v: View) => void;
  primary: ProductionOperation;
  onPrimary: (o: ProductionOperation) => void;
}) {
  const out = data.output;
  const f = data.overview;
  const nothingAtAll = out.recordedDays === 0 && !data.quality?.summary.auditCount && !data.fabric?.summary.recordCount;
  const rft = data.quality?.rft;
  const delivery = data.delivery;
  const ops = PRODUCTION_OPERATIONS;

  return (
    <>
      {/* The four numbers most people come for. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Garments sewn"
          tone="accent"
          value={f.garmentsSewn == null ? <Unrecorded /> : fmtNumber(f.garmentsSewn)}
          sub={f.garmentsSewn == null ? 'No sewing recorded in this period'
            : <>on {f.sewnRecordedDays} day{f.sewnRecordedDays === 1 ? '' : 's'} <TrendNote trend={data.overviewTrend} what="rate" /></>}
        />
        <StatTile
          label="Garments packed"
          tone="emerald"
          value={f.garmentsPacked == null ? <Unrecorded /> : fmtNumber(f.garmentsPacked)}
          sub={f.garmentsPacked == null ? 'No packing recorded in this period' : `on ${f.packedRecordedDays} day${f.packedRecordedDays === 1 ? '' : 's'}`}
        />
        <StatTile
          label="Right first time"
          tone={rft?.rftPct == null ? 'neutral' : rft.rftPct >= 98 ? 'emerald' : rft.rftPct >= 90 ? 'amber' : 'red'}
          value={rft?.rftPct == null ? <Unrecorded text="No inspections" /> : fmtPct(rft.rftPct, 0)}
          sub={rft?.rftPct == null ? 'No quality inspection decided in this period' : `${rft.passedFirstTime} of ${rft.firstInspections} inspections passed first time`}
        />
        <StatTile
          label="On-time delivery"
          tone={delivery?.onTimePct == null ? 'neutral' : delivery.onTimePct >= 98 ? 'emerald' : delivery.onTimePct >= 90 ? 'amber' : 'red'}
          value={delivery?.onTimePct == null ? <Unrecorded text="No shipments" /> : fmtPct(delivery.onTimePct, 0)}
          sub={delivery?.onTimePct == null ? 'Nothing shipped against a promised date' : `${delivery.onTime} on time, ${delivery.late} late`}
        />
      </div>

      <TabStrip tabs={VIEWS.map((v) => ({ key: v.key, label: v.label }))} active={view} onChange={onView} />

      {nothingAtAll && view !== 'workers' && view !== 'records' ? (
        <Card>
          <EmptyState
            title="Nothing was recorded in this period"
            detail="Production is recorded on each order's Production tab. Try another week or month above."
          />
        </Card>
      ) : view === 'overview' ? (
        <>
          <AnalysisCharts data={data} />
          <OverviewSection overview={f} />
        </>
      ) : view === 'records' ? (
        <ProductionRecords data={data} defaultDate={data.range.to < localToday() ? data.range.to : localToday()} />
      ) : view === 'orders' ? (
        <Card>
          <div className="card-header flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink-900">Orders that made something</h3>
              <p className="text-xs text-ink-500">{data.orders.length} order{data.orders.length === 1 ? '' : 's'} in this period</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-ink-600">
              <span className="whitespace-nowrap">Sort by</span>
              <ComboSelect aria-label="Sort by stage" className="input !py-1 text-xs" value={primary}
                onChange={(e) => onPrimary(e.target.value as ProductionOperation)}>
                {ops.map((o) => <option key={o} value={o}>{opLabel(o)}</option>)}
              </ComboSelect>
            </div>
          </div>
          {data.orders.length === 0 ? <EmptyState title="No order recorded production in this period" /> : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-ink-200 bg-ink-50">
                  <tr>
                    <th className="th">PO</th><th className="th">Order</th><th className="th">Client</th>
                    {ops.map((o) => <th key={o} className={clsx('th text-right', o === data.primaryOperation && 'text-accent-700')}>{opLabel(o)}</th>)}
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.orders.map((o) => (
                    <tr key={o.orderId} className="hover:bg-ink-50/60">
                      <td className="td font-medium"><Link to={`/orders/${o.orderId}?tab=production`} className="text-accent-700 hover:underline">{o.poNumber}</Link></td>
                      <td className="td">{o.orderName}</td>
                      <td className="td text-xs text-ink-600">{o.clientName}</td>
                      {ops.map((op) => (
                        <td key={op} className={clsx('td text-right', op === data.primaryOperation && 'font-medium')}><Qty value={o.byOperation[op]} /></td>
                      ))}
                      <td className="td text-right"><Link to={`/orders/${o.orderId}?tab=production`} className="btn-secondary btn-sm">Open <ArrowRight className="h-3 w-3" /></Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : view === 'workers' ? (
        <LabourSection labour={data.labour} trend={data.efficiencyTrend} dayLogs={data.dayLogs} />
      ) : (
        <>
          {(data.quality || data.fabric) && (
            <div className="grid gap-3 sm:grid-cols-2">
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
          )}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {data.quality && <RftCard rft={data.quality.rft} />}
            {data.delivery && <DeliveryCard delivery={data.delivery} />}
          </div>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {data.quality && <QualityCard quality={data.quality} />}
            {data.fabric && <FabricCard fabric={data.fabric} />}
          </div>
        </>
      )}
    </>
  );
}

// ── Overall factory productivity ────────────────────────────────────────────
//
// Three separate things, never added together: unique garments (sewn),
// finished goods (packed) and pieces through each stage. A record is pieces
// through one operation and a garment passes through several, so a sum across
// stages would count one garment up to five times.

function OverviewSection({ overview: f }: { overview: FactoryOverview }) {
  const recordedStages = f.stages.filter((s) => s.recorded);
  const chartData = f.days.map((d) => ({ date: d.date, recorded: d.recorded, ...d.byOperation }));

  return (
    <section className="space-y-4">
      <div>
        <Card>
          <CardHeader
            title="Every stage, day by day"
            subtitle={recordedStages.length === 0
              ? 'No production recorded in this period.'
              : `One line per stage. Grey days have nothing recorded: ${f.recordedDays} of ${f.calendarDays} days recorded.`}
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

function LabourSection({ labour: l, trend, dayLogs }: {
  labour: LabourSummary; trend: Trend; dayLogs: ProductivityDayLogDto[];
}) {
  const effTone = l.efficiencyPct == null ? 'neutral' : l.efficiencyPct >= 75 ? 'emerald' : l.efficiencyPct >= 50 ? 'amber' : 'red';
  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Garments per worker per day"
          value={l.piecesPerOperatorDay == null ? <Unrecorded /> : fmtNumber(l.piecesPerOperatorDay, { places: 1 })}
          sub={l.piecesPerOperatorDay == null ? 'Fill in the operators on the day sheet below' : 'Garments sewn ÷ operators, on the days filled in below'}
        />
        <StatTile
          label="Garments per machine per day"
          value={l.piecesPerMachineDay == null ? <Unrecorded /> : fmtNumber(l.piecesPerMachineDay, { places: 1 })}
          sub={l.piecesPerMachineDay == null ? 'Fill in the machines on the day sheet below' : 'Garments sewn ÷ machines running'}
        />
        {/* Only when there is a figure: it needs each style's standard minutes,
            which new orders no longer carry, and an empty tile only confuses. */}
        {l.efficiencyPct != null && (
          <StatTile
            label="Line efficiency"
            tone={effTone}
            value={fmtPct(l.efficiencyPct, 1)}
            sub={<>{l.countedDays} of {l.sewingDays} sewing day{l.sewingDays === 1 ? '' : 's'} counted. Target 75%. <TrendNote trend={trend} what="rate" unit="pct" /></>}
          />
        )}
        {l.producedSah != null && (
          <StatTile
            label="Standard hours produced"
            value={fmtNumber(l.producedSah, { places: 1 })}
            sub={`on ${l.countedDays} day${l.countedDays === 1 ? '' : 's'}, ${fmtNumber(l.avgManpower, { places: 1 })} people on average`}
          />
        )}
      </div>

      <DayLogSheet labour={l} dayLogs={dayLogs} />
    </section>
  );
}

/** The daily sheet: one row per day of the period, saved a row at a time. */
function DayLogSheet({ labour, dayLogs }: { labour: LabourSummary; dayLogs: ProductivityDayLogDto[] }) {
  const { can } = useAuth();
  const editable = can('production:write');
  const byDate = useMemo(() => new Map(dayLogs.map((d) => [d.date, d])), [dayLogs]);
  return (
    <Card>
      <CardHeader
        title="Day sheet"
        subtitle={editable
          ? 'Fill in who worked each day. The garments sewn come from the production records.'
          : 'Who worked each day. You need permission to record production to edit it.'}
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
  return (
    <tr className={clsx(day.sewn == null && 'text-ink-400')}>
      <td className="td whitespace-nowrap font-medium">{fmtDate(day.date)}</td>
      <td className="td text-right"><Qty value={day.sewn} /></td>
      <td className="td text-right">{cell('operators', 5000)}</td>
      <td className="td text-right">{cell('helpers', 5000)}</td>
      <td className="td text-right">{cell('workingMinutes', 1440)}</td>
      <td className="td text-right">{cell('machinesRunning', 5000)}</td>
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
      <CardHeader title="Right first time" subtitle="Inspections that passed the first time." />
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
      <CardHeader title="Delivery" subtitle="Shipments that left in this period, against the date promised." />
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

// ── Pieces ──────────────────────────────────────────────────────────────────

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
  // Nothing to compare with is left unsaid: "no comparison" under a number
  // reads as a problem when it is only an absence.
  if (trend.changePct == null) return null;
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
