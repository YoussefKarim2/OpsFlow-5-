/**
 * External work as a structured document.
 *
 * Built on the Proforma Invoice's pattern — the whole table edited in place and
 * saved once — because the job is the same shape: a coordinator books three
 * printing runs and corrects a fourth before pressing Save, and one request per
 * row would leave the order half-booked if the third failed.
 *
 * Fields are the ones External Work already had. Nothing is borrowed from the
 * proforma that makes no sense here: an operation has a factory, a return date
 * and an approval flag, none of which an invoice line does.
 *
 * Rows that have already left the building are read-only. Status belongs to the
 * transition route, which enforces the customer-approval gate, and an editor
 * that could also set it would be a way around that gate.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Lock } from 'lucide-react';
import { api } from '../lib/api';
import { Num, ErrorNote, clsx } from './ui';

export interface ExternalOpRow {
  id?: string;
  operationType: string;
  operationSort?: string | null;
  externalFactoryId?: string | null;
  externalReference?: string | null;
  qty: number;
  unitPriceUsd: number | null;
  expectedReturnDate?: string | null;
  requiresApproval: boolean;
  notes?: string | null;
  /** Present on stored rows. Absent on new ones. */
  status?: string;
}

/** Work that has left the building is a record, not a draft. */
const EDITABLE = new Set(['NOT_SENT', 'WAITING_APPROVAL']);
const isLocked = (r: ExternalOpRow) => !!r.status && !EDITABLE.has(r.status);

const blank = (): ExternalOpRow => ({
  operationType: '', qty: 0, unitPriceUsd: null, requiresApproval: false,
});

export function ExternalWorkEditor({
  orderId, initial, factories, workTypes, onSaved,
}: {
  orderId: string;
  initial: ExternalOpRow[];
  factories: Array<{ id: string; name: string }>;
  /** `RefValue` rows of kind EXTERNAL_WORK_TYPE, from /lookups. */
  workTypes: string[];
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<ExternalOpRow[]>(initial);

  const save = useMutation({
    mutationFn: () => api.external.saveOperations(orderId, rows.map((r) => ({
      id: r.id,
      operationType: r.operationType,
      operationSort: r.operationSort || undefined,
      externalFactoryId: r.externalFactoryId || undefined,
      externalReference: r.externalReference || undefined,
      qty: r.qty,
      unitPriceUsd: r.unitPriceUsd ?? undefined,
      expectedReturnDate: r.expectedReturnDate || undefined,
      requiresApproval: r.requiresApproval,
      notes: r.notes || undefined,
      colorIds: [],
    }))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['external', orderId] });
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      onSaved?.();
    },
  });

  const set = (i: number, patch: Partial<ExternalOpRow>) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const invalid = rows.some((r) => !r.operationType.trim() || r.qty <= 0);
  const total = rows.reduce((a, r) => a + r.qty * (r.unitPriceUsd ?? 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="label mb-0">Operations</span>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setRows([...rows, blank()])}>
            <Plus className="h-3.5 w-3.5" /> Add an operation
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={save.isPending || invalid}
            title={invalid ? 'Every operation needs a type and a quantity above zero' : undefined}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {save.error ? <ErrorNote error={save.error} /> : null}

      <div className="overflow-x-auto">
        <table className="w-full border border-ink-200">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              <th className="th">Operation</th>
              <th className="th w-40">Factory</th>
              <th className="th w-28">Reference</th>
              <th className="th w-24 text-right">Qty</th>
              <th className="th w-28 text-right">Unit price</th>
              <th className="th w-28 text-right">Total</th>
              <th className="th w-36">Expected back</th>
              <th className="th w-24">Approval</th>
              <th className="th w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="td py-6 text-center text-ink-500">
                  No outside work booked. Add an operation, or import a document that carries them.
                </td>
              </tr>
            ) : null}

            {rows.map((r, i) => {
              const locked = isLocked(r);
              return (
                <tr key={i} className={clsx(locked && 'bg-ink-50/60')}>
                  <td className="p-1">
                    <input
                      className={clsx('input border-transparent bg-transparent', !r.operationType.trim() && !locked && 'ring-1 ring-red-400')}
                      value={r.operationType} list="external-work-types" disabled={locked}
                      placeholder="Printing, Embroidery…"
                      onChange={(e) => set(i, { operationType: e.target.value })}
                    />
                  </td>
                  <td className="p-1">
                    <select
                      className="input border-transparent bg-transparent" disabled={locked}
                      value={r.externalFactoryId ?? ''}
                      onChange={(e) => set(i, { externalFactoryId: e.target.value || null })}
                    >
                      <option value="">—</option>
                      {factories.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </td>
                  <td className="p-1">
                    <input className="input border-transparent bg-transparent" disabled={locked}
                      value={r.externalReference ?? ''}
                      onChange={(e) => set(i, { externalReference: e.target.value || null })} />
                  </td>
                  <td className="p-1">
                    <input
                      className={clsx('input tnum border-transparent bg-transparent text-right', r.qty <= 0 && !locked && 'ring-1 ring-red-400')}
                      value={r.qty || ''} disabled={locked}
                      onChange={(e) => set(i, { qty: Number(e.target.value) || 0 })} />
                  </td>
                  <td className="p-1">
                    <input className="input tnum border-transparent bg-transparent text-right" disabled={locked}
                      value={r.unitPriceUsd ?? ''} placeholder="—"
                      onChange={(e) => set(i, { unitPriceUsd: e.target.value === '' ? null : Number(e.target.value) })} />
                  </td>
                  <td className="td tnum text-right font-semibold">
                    <Num value={r.unitPriceUsd == null ? null : r.qty * r.unitPriceUsd} kind="money" places={2} />
                  </td>
                  <td className="p-1">
                    <input type="date" className="input border-transparent bg-transparent" disabled={locked}
                      value={(r.expectedReturnDate ?? '').slice(0, 10)}
                      onChange={(e) => set(i, { expectedReturnDate: e.target.value || null })} />
                  </td>
                  <td className="p-1 text-center">
                    <input type="checkbox" checked={r.requiresApproval} disabled={locked}
                      title="Customer approval needed before this can be sent"
                      onChange={(e) => set(i, { requiresApproval: e.target.checked })} />
                  </td>
                  <td className="p-1 text-right">
                    {locked ? (
                      <span title={`Already ${r.status?.toLowerCase().replace(/_/g, ' ')} — record what happened instead`}>
                        <Lock className="h-3.5 w-3.5 text-ink-400" />
                      </span>
                    ) : (
                      <button type="button" className="btn-ghost btn-sm text-red-600"
                        onClick={() => setRows(rows.filter((_, n) => n !== i))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 0 ? (
            <tfoot className="border-t border-ink-200 bg-ink-50">
              <tr>
                <td colSpan={5} className="td text-right font-medium">Outside work cost</td>
                <td className="td tnum text-right font-semibold">
                  <Num value={total || null} kind="money" places={2} />
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {rows.some(isLocked) ? (
        <p className="text-xs text-ink-500">
          Rows with a padlock have already been sent. Record what happened to them from the
          operations list rather than editing them here.
        </p>
      ) : null}

      <datalist id="external-work-types">
        {workTypes.map((t) => <option key={t} value={t} />)}
      </datalist>
    </div>
  );
}
