/**
 * The sizes inside one carton.
 *
 * A mixed carton — ten small, twenty medium, fifteen large in the same box — is
 * a real thing that the single `orderSizeId` on a carton could not describe.
 * Size is a dropdown from the order's own sizes and quantity is its own numeric
 * field; the two are never one string, because a carton whose contents live in
 * free text cannot be counted.
 *
 * The whole breakdown is saved in one request. The server adjusts the PACKED
 * ledger by the difference each size makes rather than by the new total, which
 * is what stops an edit counting the same pieces twice.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { Num, ErrorNote, clsx } from './ui';

export interface CartonLineRow {
  orderSizeId: string | null;
  qty: number;
}

export function CartonSizes({
  cartonId, orderId, sizes, initial, onSaved,
}: {
  cartonId: string;
  orderId: string;
  sizes: Array<{ id: string; name: string }>;
  initial: CartonLineRow[];
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<CartonLineRow[]>(
    initial.length > 0 ? initial : [{ orderSizeId: sizes[0]?.id ?? null, qty: 0 }],
  );

  const save = useMutation({
    mutationFn: () => api.packing.saveCartonLines(
      cartonId,
      rows.filter((r) => r.qty > 0 && r.orderSizeId).map((r) => ({ orderSizeId: r.orderSizeId, qty: r.qty })),
    ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['packing', orderId] });
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      onSaved?.();
    },
  });

  const set = (i: number, patch: Partial<CartonLineRow>) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const usable = rows.filter((r) => r.qty > 0 && r.orderSizeId);
  const total = usable.reduce((a, r) => a + r.qty, 0);

  // The same size twice in one carton is two rows that should be one, and the
  // ledger would still be right — but the carton would read as if it held two
  // separate lots of the same thing.
  const duplicated = new Set(
    usable.map((r) => r.orderSizeId).filter((id, i, all) => all.indexOf(id) !== i),
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <label className="text-xs text-ink-500 w-10">Size</label>
            <select
              className={clsx('input w-40', r.orderSizeId && duplicated.has(r.orderSizeId) && 'ring-1 ring-amber-400')}
              value={r.orderSizeId ?? ''}
              onChange={(e) => set(i, { orderSizeId: e.target.value || null })}
            >
              <option value="">—</option>
              {sizes.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>

            <label className="ml-2 text-xs text-ink-500">Quantity</label>
            <input
              className="input tnum w-28 text-right"
              value={r.qty || ''}
              onChange={(e) => set(i, { qty: Number(e.target.value) || 0 })}
            />

            <button
              type="button"
              className="btn-ghost btn-sm text-red-600"
              title="Remove this size"
              onClick={() => setRows(rows.filter((_, n) => n !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="btn-ghost btn-sm"
        onClick={() => setRows([...rows, { orderSizeId: sizes[0]?.id ?? null, qty: 0 }])}
      >
        <Plus className="h-3.5 w-3.5" /> Add size
      </button>

      {duplicated.size > 0 ? (
        <p className="text-xs text-amber-700">
          The same size appears more than once. That will be packed as one total, but it is
          usually a mistake — combine the rows unless you meant it.
        </p>
      ) : null}

      {save.error ? <ErrorNote error={save.error} /> : null}

      <div className="flex items-center justify-between border-t border-ink-200 pt-3">
        <span className="text-sm">
          <span className="text-ink-500">Carton total </span>
          <strong className="tnum"><Num value={total || null} places={0} /></strong>
          <span className="ml-1 text-xs text-ink-500">
            across {usable.length} size{usable.length === 1 ? '' : 's'}
          </span>
        </span>
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={save.isPending || usable.length === 0}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save sizes'}
        </button>
      </div>

      <p className="text-2xs text-ink-500">
        Rows with no size or no quantity are skipped. The carton&rsquo;s total becomes the sum above.
      </p>
    </div>
  );
}
