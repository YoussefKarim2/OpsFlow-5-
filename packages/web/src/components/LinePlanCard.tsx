/**
 * The production line an order runs on: its machines and its target per day.
 *
 * The factory's Production sheet keeps this beside the daily log — a "Machine
 * Qty / Machine Type" table with its total, and "Target Production / Day" —
 * and it is entered the same way here: the sheet's six machine types are
 * offered, blanks stay blank, and any other type can be added.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { LINE_MACHINE_TYPES, daysAtTarget, fmtNumber, type LinePlan } from '@opsflow/shared';
import { api, ApiError } from '../lib/api';
import { Card, CardHeader, ErrorNote, useToast } from './ui';

interface Draft { target: string; lineName: string; machines: Array<{ type: string; qty: string }> }

const toDraft = (p: LinePlan): Draft => {
  const machines = p.machines.map((m) => ({ type: m.type, qty: m.qty == null ? '' : String(m.qty) }));
  // The sheet's own types are always offered, in its order, before any other.
  for (const t of LINE_MACHINE_TYPES) {
    if (!machines.some((m) => m.type.toLowerCase() === t.toLowerCase())) machines.push({ type: t, qty: '' });
  }
  const rank = (t: string) => {
    const i = LINE_MACHINE_TYPES.findIndex((x) => x.toLowerCase() === t.toLowerCase());
    return i < 0 ? LINE_MACHINE_TYPES.length : i;
  };
  machines.sort((a, b) => rank(a.type) - rank(b.type));
  return { target: p.targetPerDay == null ? '' : String(p.targetPerDay), lineName: p.lineName ?? '', machines };
};

const wholeOrBlank = (t: string) => /^\d*$/.test(t.trim());

export function LinePlanCard({
  orderId, plan, remaining, canEdit,
}: { orderId: string; plan: LinePlan; remaining: number; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (d: Draft) => api.production.saveLinePlan(orderId, {
      targetPerDay: d.target.trim() === '' ? null : Number(d.target),
      lineName: d.lineName.trim() || null,
      // A type with no machines and no count is the sheet's blank row: kept, so the table reads as the sheet does.
      machines: d.machines
        .filter((m) => m.type.trim())
        .map((m) => ({ type: m.type.trim(), qty: m.qty.trim() === '' ? null : Number(m.qty) })),
    }),
    onSuccess: () => {
      setDraft(null); setError(null);
      toast.success('Line plan saved');
      // The costing reads the line machines and the target from here.
      for (const k of ['production', 'order', 'costing']) void qc.invalidateQueries({ queryKey: [k, orderId] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the line plan.'),
  });

  const days = daysAtTarget(remaining, plan.targetPerDay);

  if (draft) {
    const invalid = !wholeOrBlank(draft.target) || draft.machines.some((m) => !wholeOrBlank(m.qty))
      || draft.machines.some((m) => !m.type.trim() && m.qty.trim() !== '');
    const total = draft.machines.reduce((a, m) => a + (Number(m.qty) || 0), 0);
    const setMachine = (i: number, patch: Partial<Draft['machines'][number]>) =>
      setDraft({ ...draft, machines: draft.machines.map((m, n) => (n === i ? { ...m, ...patch } : m)) });
    return (
      <Card>
        <CardHeader title="Target production per day" subtitle="The line's machines and its daily target" />
        <div className="space-y-4 p-4">
          {error && <ErrorNote error={new Error(error)} />}
          <div className="flex flex-wrap gap-4">
            <label className="block">
              <span className="label">Target production / day (pcs)</span>
              <input className="input w-40 tnum text-right" inputMode="numeric" value={draft.target} placeholder="500"
                aria-label="Target production per day"
                onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
            </label>
            <label className="block">
              <span className="label">Production line</span>
              <input className="input w-48" value={draft.lineName} placeholder="Line 1" maxLength={80}
                aria-label="Production line"
                onChange={(e) => setDraft({ ...draft, lineName: e.target.value })} />
            </label>
          </div>
          <table className="border border-ink-200">
            <thead className="bg-ink-900 text-white">
              <tr>
                <th className="px-3 py-1.5 text-left text-xs font-semibold">Machine type</th>
                <th className="px-3 py-1.5 text-right text-xs font-semibold">Machine qty</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {draft.machines.map((m, i) => (
                <tr key={i}>
                  <td className="p-1">
                    <input className="input w-44 border-transparent bg-transparent" value={m.type} maxLength={60}
                      aria-label="Machine type" placeholder="Machine type"
                      onChange={(e) => setMachine(i, { type: e.target.value })} />
                  </td>
                  <td className="p-1">
                    <input className="input w-24 tnum border-transparent bg-transparent text-right" inputMode="numeric"
                      aria-label={`${m.type || 'Machine'} qty`} value={m.qty} placeholder="—"
                      onChange={(e) => setMachine(i, { qty: e.target.value })} />
                  </td>
                  <td className="p-1 text-right">
                    <button type="button" className="btn-ghost btn-sm text-red-600" title="Remove this machine type"
                      onClick={() => setDraft({ ...draft, machines: draft.machines.filter((_, n) => n !== i) })}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              <tr className="bg-ink-50 font-semibold">
                <td className="px-3 py-1.5 text-sm">Total</td>
                <td className="px-3 py-1.5 text-right text-sm tnum">{fmtNumber(total)}</td>
                <td />
              </tr>
            </tbody>
          </table>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary btn-sm"
              onClick={() => setDraft({ ...draft, machines: [...draft.machines, { type: '', qty: '' }] })}>
              <Plus className="h-3.5 w-3.5" /> Add a machine type
            </button>
            <span className="flex-1" />
            {invalid && <span className="text-xs text-red-700">Counts and the target are whole numbers.</span>}
            <button type="button" className="btn-secondary btn-sm" onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
            <button type="button" className="btn-primary btn-sm" disabled={invalid || save.isPending} onClick={() => save.mutate(draft)}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </Card>
    );
  }

  const shown = plan.machines;
  return (
    <Card>
      <CardHeader
        title="Target production per day"
        subtitle={plan.lineName ? `Production line: ${plan.lineName}` : 'The line\'s machines and its daily target'}
        action={canEdit && (
          <button className="btn-secondary btn-sm" onClick={() => setDraft(toDraft(plan))}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
        )}
      />
      <div className="flex flex-wrap items-start gap-6 p-4">
        <div className="min-w-[12rem]">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Target production / day</p>
          <p className="mt-1 text-3xl font-semibold tnum text-ink-900">
            {plan.targetPerDay == null ? <span className="text-ink-300">—</span> : fmtNumber(plan.targetPerDay)}
            {plan.targetPerDay != null && <span className="ml-1 text-sm font-normal text-ink-500">pcs</span>}
          </p>
          {days != null && (
            <p className="mt-1 text-xs text-ink-600">
              {fmtNumber(remaining)} pcs left: {days} working day{days === 1 ? '' : 's'} at this target.
            </p>
          )}
          {plan.targetPerDay != null && plan.totalMachines > 0 && (
            <p className="mt-0.5 text-xs text-ink-500">{fmtNumber(Math.round(plan.targetPerDay / plan.totalMachines))} pcs per machine a day.</p>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-ink-500">
            No machines entered yet.{canEdit ? ' Edit to enter the line\'s machines and its target.' : ''}
          </p>
        ) : (
          <table className="border border-ink-200">
            <thead className="bg-ink-900 text-white">
              <tr>
                <th className="px-3 py-1.5 text-left text-xs font-semibold">Machine type</th>
                <th className="px-3 py-1.5 text-right text-xs font-semibold">Machine qty</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {shown.map((m) => (
                <tr key={m.type}>
                  <td className="px-3 py-1 text-sm">{m.type}</td>
                  <td className="px-3 py-1 text-right text-sm tnum">{m.qty == null ? <span className="text-ink-300">—</span> : fmtNumber(m.qty)}</td>
                </tr>
              ))}
              <tr className="bg-ink-50 font-semibold">
                <td className="px-3 py-1 text-sm">Total</td>
                <td className="px-3 py-1 text-right text-sm tnum">{fmtNumber(plan.totalMachines)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
