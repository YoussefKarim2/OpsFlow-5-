/**
 * Manual costs alongside the derived ones.
 *
 * Actual Costing reads the production sections — the BOM, outside work, the
 * production follow-up — and proposes what those already support. That covers
 * most of a costing and none of the surprises, so this is where a person adds
 * the freight nobody planned, corrects a rate, and says why.
 *
 * Derived and manual lines are shown together but never mixed up. A derived
 * line carries the section it came from and is not editable here: it is
 * recomputed on every save, so an edit would be silently discarded, and a field
 * that quietly throws work away is worse than one that is plainly read-only.
 * To change a derived number you change the fact underneath it.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Link2 } from 'lucide-react';
import { api, type CostLineDto, type CostingDto } from '../lib/api';
import { Num, ErrorNote, clsx } from './ui';

const GROUPS = ['FABRIC', 'ACCESSORY', 'EXTERNAL', 'LABOUR', 'OTHER'] as const;

const GROUP_LABEL: Record<(typeof GROUPS)[number], string> = {
  FABRIC: 'Fabric', ACCESSORY: 'Accessories', EXTERNAL: 'Outside work',
  LABOUR: 'Production', OTHER: 'Other',
};

/** "bom:FABRIC" → "Bill of materials · Fabric". */
function explainSource(ref: string | null | undefined): string {
  if (!ref) return 'Derived';
  const [section, detail] = ref.split(':');
  const name = section === 'bom' ? 'Bill of materials'
    : section === 'external' ? 'Outside work'
    : section === 'production' ? 'Production follow-up'
    : section;
  const tail = (detail ?? '').replace(/[_-]+/g, ' ').toLowerCase();
  return tail ? `${name} · ${tail}` : name;
}

const lineCost = (l: CostLineDto) =>
  l.quantity == null || l.unitPriceUsd == null ? null : l.quantity * l.unitPriceUsd;

export function CostingEditor({
  orderId, record, derived, onSaved,
}: {
  orderId: string;
  record: CostingDto | null;
  /** What the production sections currently support. Recomputed on save. */
  derived: CostLineDto[];
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [dollarRate, setDollarRate] = useState(String(record?.dollarRate ?? 48.5));
  const [dailyCostEgp, setDailyCostEgp] = useState(record?.dailyCostEgp?.toString() ?? '');
  const [machineDaysUsed, setMachineDaysUsed] = useState(record?.machineDaysUsed?.toString() ?? '');
  const [notes, setNotes] = useState(record?.notes ?? '');
  const [manual, setManual] = useState<CostLineDto[]>(
    (record?.lines ?? []).filter((l) => l.source !== 'DERIVED'),
  );

  const stored = (record?.lines ?? []).filter((l) => l.source === 'DERIVED');
  // Before a first save there is nothing stored, so show what would be derived.
  const shown = stored.length > 0 ? stored : derived;

  const save = useMutation({
    mutationFn: () => api.steps.saveCosting(orderId, {
      dollarRate: Number(dollarRate) || 0,
      dailyCostEgp: dailyCostEgp === '' ? null : Number(dailyCostEgp),
      machineDaysUsed: machineDaysUsed === '' ? null : Number(machineDaysUsed),
      machineCount: record?.machineCount ?? null,
      daysInLine: record?.daysInLine ?? null,
      notes: notes || null,
      manualLines: manual.filter((m) => m.label.trim()),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['costing', orderId] });
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      onSaved?.();
    },
  });

  const set = (i: number, patch: Partial<CostLineDto>) =>
    setManual((ms) => ms.map((m, n) => (n === i ? { ...m, ...patch } : m)));

  const derivedTotal = shown.reduce((a, l) => a + (lineCost(l) ?? 0), 0);
  const manualTotal = manual.reduce((a, l) => a + (lineCost(l) ?? 0), 0);
  const rateInvalid = !(Number(dollarRate) > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="label">Dollar rate</span>
          <input
            className={clsx('input tnum', rateInvalid && 'ring-1 ring-red-400')}
            value={dollarRate}
            onChange={(e) => setDollarRate(e.target.value)}
          />
          {rateInvalid ? <p className="mt-1 text-2xs text-red-600">Must be above zero.</p> : null}
        </label>
        <label className="block">
          <span className="label">Daily cost (EGP)</span>
          <input className="input tnum" value={dailyCostEgp} onChange={(e) => setDailyCostEgp(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Machine-days used</span>
          <input className="input tnum" value={machineDaysUsed} onChange={(e) => setMachineDaysUsed(e.target.value)} />
        </label>
      </div>

      {/* ── Derived ────────────────────────────────────────────────────── */}
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="label mb-0">From the production sections</span>
          <span className="text-2xs text-ink-500">Recalculated on every save</span>
        </div>
        {shown.length === 0 ? (
          <p className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2.5 text-xs text-ink-600">
            Nothing can be costed automatically yet. A BOM item needs a price, an outside
            operation needs a rate, and production needs its machine-days — each becomes a
            line here as soon as it is recorded.
          </p>
        ) : (
          <table className="w-full border border-ink-200">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Cost</th>
                <th className="th w-44">Where it came from</th>
                <th className="th w-28 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {shown.map((l, i) => (
                <tr key={i}>
                  <td className="td">
                    <span className="chip mr-2 bg-ink-100 text-ink-700 ring-ink-300/40">{GROUP_LABEL[l.group]}</span>
                    {l.label}
                  </td>
                  <td className="td text-xs text-ink-500">
                    <span className="inline-flex items-center gap-1">
                      <Link2 className="h-3 w-3 shrink-0" />
                      {explainSource(l.sourceRef)}
                    </span>
                  </td>
                  <td className="td tnum text-right"><Num value={lineCost(l)} kind="money" places={2} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Manual ─────────────────────────────────────────────────────── */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="label mb-0">Added by hand</span>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => setManual([...manual, {
              group: 'OTHER', label: '', quantity: 1, unit: 'LOT', unitPriceUsd: null, note: null,
            }])}
          >
            <Plus className="h-3.5 w-3.5" /> Add a cost
          </button>
        </div>

        {manual.length === 0 ? (
          <p className="text-xs text-ink-500">
            Nothing added. Use this for an unexpected cost, or to correct one the data cannot show.
          </p>
        ) : (
          <table className="w-full border border-ink-200">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th w-36">Group</th>
                <th className="th">Cost</th>
                <th className="th w-20 text-right">Qty</th>
                <th className="th w-28 text-right">Unit price</th>
                <th className="th w-28 text-right">Amount</th>
                <th className="th">Why</th>
                <th className="th w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {manual.map((m, i) => (
                <tr key={i}>
                  <td className="p-1">
                    <select className="input border-transparent bg-transparent" value={m.group}
                      onChange={(e) => set(i, { group: e.target.value as CostLineDto['group'] })}>
                      {GROUPS.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
                    </select>
                  </td>
                  <td className="p-1">
                    <input
                      className={clsx('input border-transparent bg-transparent', !m.label.trim() && 'ring-1 ring-red-400')}
                      value={m.label} placeholder="Air freight, rework…"
                      onChange={(e) => set(i, { label: e.target.value })} />
                  </td>
                  <td className="p-1">
                    <input className="input tnum border-transparent bg-transparent text-right" value={m.quantity ?? ''}
                      onChange={(e) => set(i, { quantity: e.target.value === '' ? null : Number(e.target.value) })} />
                  </td>
                  <td className="p-1">
                    <input className="input tnum border-transparent bg-transparent text-right" value={m.unitPriceUsd ?? ''}
                      onChange={(e) => set(i, { unitPriceUsd: e.target.value === '' ? null : Number(e.target.value) })} />
                  </td>
                  <td className="td tnum text-right font-semibold">
                    <Num value={lineCost(m)} kind="money" places={2} />
                  </td>
                  <td className="p-1">
                    <input className="input border-transparent bg-transparent" value={m.note ?? ''}
                      placeholder="Reason for the adjustment"
                      onChange={(e) => set(i, { note: e.target.value || null })} />
                  </td>
                  <td className="p-1 text-right">
                    <button type="button" className="btn-ghost btn-sm text-red-600"
                      onClick={() => setManual(manual.filter((_, n) => n !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <label className="block">
        <span className="label">Notes</span>
        <textarea className="input min-h-[4rem]" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      {save.error ? <ErrorNote error={save.error} /> : null}

      <div className="flex items-center justify-between border-t border-ink-200 pt-3">
        <div className="text-sm">
          <span className="text-ink-500">Derived </span>
          <strong className="tnum"><Num value={derivedTotal || null} kind="money" places={2} /></strong>
          <span className="mx-2 text-ink-300">+</span>
          <span className="text-ink-500">manual </span>
          <strong className="tnum"><Num value={manualTotal || null} kind="money" places={2} /></strong>
          <span className="mx-2 text-ink-300">=</span>
          <strong className="tnum"><Num value={(derivedTotal + manualTotal) || null} kind="money" places={2} /></strong>
        </div>
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={save.isPending || rateInvalid || manual.some((m) => !m.label.trim())}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save costing'}
        </button>
      </div>
    </div>
  );
}
