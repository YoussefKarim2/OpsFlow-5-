/**
 * Production follow-up and analytics — the brief's sections 18 and 19.
 *
 * The workbook's version of this was four columns and a SUM. Everything that
 * makes it actionable — the rate, the rate that is actually needed, and the
 * date the order will finish at the current rate — was never in the file.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import { Plus, AlertTriangle, Trash2 } from 'lucide-react';
import { fmtDate, fmtDateShort, fmtNumber, type OrderDetailDto } from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, StatTile, Num, Modal, Field,
  Spinner, ErrorNote, EmptyState,
} from '../../components/ui';

const OPERATIONS = ['CUTTING', 'SEWING', 'PRINTING', 'EMBROIDERY', 'WASHING', 'FINISHING', 'PACKING'] as const;

export function ProductionTab({ order }: { order: OrderDetailDto }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['production', order.id],
    queryFn: () => api.production.get(order.id),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.production.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['production', order.id] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
  });

  if (isLoading) return <Spinner />;
  if (!data) return null;

  const a = data.analytics;

  const chartData = a.series.map((s) => ({
    date: s.date,
    daily: s.qty,
    cumulative: s.cumulative,
  }));

  return (
    <div className="space-y-4 p-5">
      {a.isBehindSchedule && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div>
              <p className="text-sm font-semibold text-red-900">Production is behind schedule</p>
              <p className="mt-0.5 text-xs leading-relaxed text-red-800">
                At the current rate of <Num value={a.dailyRate} suffix=" pcs/day" />, the remaining{' '}
                <Num value={a.remainingQty} /> pieces finish on{' '}
                <strong>{a.projectedCompletion ? fmtDate(a.projectedCompletion) : 'an unknown date'}</strong>
                {a.slipDays != null && a.slipDays > 0 && <> — {a.slipDays} day{a.slipDays === 1 ? '' : 's'} after the required delivery date</>}.
                To finish on time the line needs <strong><Num value={a.requiredDailyRate} suffix=" pcs/day" /></strong>.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatTile label="Order qty" value={fmtNumber(a.orderQty)} />
        <StatTile label="Cut qty" value={fmtNumber(a.cutQty)} />
        <StatTile label="Produced" value={fmtNumber(a.producedQty)} tone="accent" sub={<Num value={a.producedPct} kind="percent" />} />
        <StatTile label="Remaining" value={fmtNumber(a.remainingQty)} tone={a.remainingQty > 0 ? 'amber' : 'emerald'} />
        <StatTile
          label="Current rate"
          value={<Num value={a.dailyRate} places={0} fallback="—" />}
          sub={a.peakDailyRate ? `peak ${fmtNumber(a.peakDailyRate)}/day` : 'pcs per active day'}
        />
        <StatTile
          label="Required rate"
          value={<Num value={a.requiredDailyRate} places={0} fallback="—" />}
          tone={a.isBehindSchedule ? 'red' : 'emerald'}
          sub="to hit the delivery date"
        />
      </div>

      <Card>
        <CardHeader
          title="Daily output"
          subtitle={
            a.projectedCompletion
              ? `Projected completion ${fmtDate(a.projectedCompletion)} · required ${fmtDate(order.requiredDeliveryDate)}`
              : 'No rate yet — projection unavailable'
          }
          action={
            can('production:write') && (
              <button onClick={() => setAdding(true)} className="btn-primary btn-sm">
                <Plus className="h-3.5 w-3.5" /> Record output
              </button>
            )
          }
        />
        <div className="p-4">
          {chartData.length === 0 ? (
            <EmptyState
              title="No production recorded"
              detail="Once daily output is logged, the rate, the required rate and the projected completion date all appear here."
            />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eceef2" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(d: string) => fmtDateShort(d)} tick={{ fontSize: 11, fill: '#65758d' }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#65758d' }} axisLine={false} tickLine={false} width={52} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: '#65758d' }} axisLine={false} tickLine={false} width={52} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #d5dae2' }}
                  labelFormatter={(d) => fmtDate(String(d))}
                  formatter={(v: number, n: string) => [`${v.toLocaleString()} pcs`, n === 'daily' ? 'Daily' : 'Cumulative']}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => (v === 'daily' ? 'Daily output' : 'Cumulative')} />
                <ReferenceLine yAxisId="right" y={a.orderQty} stroke="#c81d25" strokeDasharray="4 4"
                  label={{ value: 'Order qty', fontSize: 10, fill: '#c81d25', position: 'insideTopRight' }} />
                <Bar yAxisId="left" dataKey="daily" fill="#8ec7ff" radius={[3, 3, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="cumulative" stroke="#1c67f0" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="By operation" />
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Operation</th>
                <th className="th text-right">Total</th>
                <th className="th text-right">Days</th>
                <th className="th text-right">Avg/day</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.byOperation.length === 0 && (
                <tr><td colSpan={4} className="td text-center text-ink-400">No records</td></tr>
              )}
              {data.byOperation.map((o) => (
                <tr key={o.operation}>
                  <td className="td font-medium">{o.operation.charAt(0) + o.operation.slice(1).toLowerCase()}</td>
                  <td className="td text-right"><Num value={o.qty} /></td>
                  <td className="td text-right"><Num value={o.days} /></td>
                  <td className="td text-right"><Num value={o.avgPerDay} places={0} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card>
          <CardHeader title="By line" subtitle="Which line is carrying the order" />
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Line</th>
                <th className="th text-right">Total</th>
                <th className="th text-right">Days</th>
                <th className="th text-right">Avg/day</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.byLine.length === 0 && (
                <tr><td colSpan={4} className="td text-center text-ink-400">No records</td></tr>
              )}
              {data.byLine.map((l) => (
                <tr key={l.line}>
                  <td className="td font-medium">{l.line}</td>
                  <td className="td text-right"><Num value={l.qty} /></td>
                  <td className="td text-right"><Num value={l.days} /></td>
                  <td className="td text-right"><Num value={l.avgPerDay} places={0} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card>
        <CardHeader title="Production log" subtitle={`${data.records.length} entries`} />
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full">
            <thead className="sticky top-0 border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Date</th>
                <th className="th">Operation</th>
                <th className="th text-right">Qty</th>
                <th className="th">Line</th>
                <th className="th">Team</th>
                <th className="th">Notes</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.records.length === 0 && (
                <tr><td colSpan={7} className="td py-6 text-center text-ink-400">Nothing logged yet.</td></tr>
              )}
              {[...data.records].reverse().map((r) => (
                <tr key={r.id}>
                  <td className="td">{fmtDate(r.date)}</td>
                  <td className="td">
                    <span className="chip bg-ink-100 text-ink-700 ring-ink-500/20">{r.operation}</span>
                  </td>
                  <td className="td text-right font-semibold"><Num value={r.qty} /></td>
                  <td className="td text-xs">{r.line || '—'}</td>
                  <td className="td text-xs">{r.team || '—'}</td>
                  <td className="td max-w-xs truncate text-xs text-ink-500">{r.notes || '—'}</td>
                  <td className="td text-right">
                    {can('production:write') && (
                      <button
                        onClick={() => remove.mutate(r.id)}
                        className="btn-ghost btn-sm text-ink-400 hover:text-red-600"
                        title="Remove this entry"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <RecordModal
        open={adding} orderId={order.id}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          void qc.invalidateQueries({ queryKey: ['production', order.id] });
          void qc.invalidateQueries({ queryKey: ['order', order.id] });
        }}
      />
    </div>
  );
}

function RecordModal({
  open, orderId, onClose, onDone,
}: {
  open: boolean; orderId: string; onClose: () => void; onDone: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ date: today, operation: 'SEWING', qty: '', line: '', team: '', notes: '' });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.production.record(orderId, {
        date: form.date, operation: form.operation, qty: Number(form.qty),
        line: form.line || undefined, team: form.team || undefined, notes: form.notes || undefined,
      }),
    onSuccess: () => { setForm({ ...form, qty: '', notes: '' }); setError(null); onDone(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not record production.'),
  });

  return (
    <Modal
      open={open} onClose={onClose}
      title="Record daily production"
      subtitle="Rate, projection and delay detection update immediately"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!form.qty || save.isPending} className="btn-primary">
            {save.isPending ? 'Saving…' : 'Record'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNote error={new Error(error)} />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="input" />
          </Field>
          <Field label="Operation">
            <select value={form.operation} onChange={(e) => setForm({ ...form, operation: e.target.value })} className="input">
              {OPERATIONS.map((o) => <option key={o} value={o}>{o.charAt(0) + o.slice(1).toLowerCase()}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Quantity (pieces)">
          <input type="number" min={0} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} className="input" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Line"><input value={form.line} onChange={(e) => setForm({ ...form, line: e.target.value })} className="input" placeholder="Line 1" /></Field>
          <Field label="Team"><input value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} className="input" /></Field>
        </div>
        <Field label="Notes"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="input" /></Field>
      </div>
    </Modal>
  );
}
