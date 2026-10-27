/**
 * Adding several sizes to a packing list in one go.
 *
 * A packing list has always held many cartons, and each carton has always named
 * one colour and one size — so multiple sizes per list was never a limitation of
 * the data, only of the typing. Filling a grid meant one dialog per size, and a
 * list half-entered if somebody was interrupted.
 *
 * Rows here become cartons, saved together. The carton numbers auto-fill from a
 * prefix because they are almost always sequential, and stay editable because
 * sometimes they are not. They continue from the cartons already on the list:
 * starting at 001 every time gave a second grid the first grid's numbers, and
 * the server now refuses a number the list already has.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { Num, ErrorNote } from './ui';
import { ComboSelect } from './ComboSelect';

/**
 * The first number this grid hands out: after every carton already on the list,
 * and after the highest one already numbered with this prefix, whichever is
 * further — so a list of eight cartons continues at 009.
 */
function firstNumber(prefix: string, existing: readonly string[]): number {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}(\\d+)$`, 'i');
  const highest = existing.reduce((m, n) => {
    const hit = pattern.exec(n.trim());
    return hit ? Math.max(m, Number(hit[1])) : m;
  }, 0);
  return Math.max(existing.length, highest) + 1;
}

const numberFor = (prefix: string, n: number) => `${prefix}${String(n).padStart(3, '0')}`;

interface GridRow {
  cartonNumber: string;
  orderColorId: string;
  orderSizeId: string;
  qty: number;
}

export function PackingSizeGrid({
  listId, orderId, colors, sizes, existingNumbers = [], onDone,
}: {
  listId: string;
  orderId: string;
  /** The carton numbers already on this list, so new ones continue after them. */
  existingNumbers?: readonly string[];
  colors: Array<{ id: string; name: string }>;
  sizes: Array<{ id: string; name: string }>;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [prefix, setPrefix] = useState('CTN-');
  const [rows, setRows] = useState<GridRow[]>(() => {
    const start = firstNumber('CTN-', existingNumbers);
    // One row per size is the shape of the job: a packing list is usually every
    // size of one colour, so starting empty would mean the same click N times.
    return sizes.map((s, i) => ({
      cartonNumber: numberFor('CTN-', start + i),
      orderColorId: colors[0]?.id ?? '',
      orderSizeId: s.id,
      qty: 0,
    }));
  });

  const save = useMutation({
    mutationFn: () => api.packing.addCartons(listId, rows.filter((r) => r.qty > 0)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['packing', orderId] });
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      // The PACKED ledger moved, and the quantity grids read it.
      void qc.invalidateQueries({ queryKey: ['matrix', orderId] });
      onDone?.();
    },
  });

  const set = (i: number, patch: Partial<GridRow>) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const renumber = (p: string) => {
    setPrefix(p);
    const start = firstNumber(p, existingNumbers);
    setRows((rs) => rs.map((r, i) => ({ ...r, cartonNumber: numberFor(p, start + i) })));
  };

  const packed = rows.filter((r) => r.qty > 0);
  const total = packed.reduce((a, r) => a + r.qty, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <label className="block">
          <span className="label">Carton number prefix</span>
          <input className="input w-40" value={prefix} onChange={(e) => renumber(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => setRows([...rows, {
            cartonNumber: numberFor(prefix, firstNumber(prefix, existingNumbers) + rows.length),
            orderColorId: colors[0]?.id ?? '', orderSizeId: sizes[0]?.id ?? '', qty: 0,
          }])}
        >
          <Plus className="h-3.5 w-3.5" /> Add a row
        </button>
      </div>

      {save.error ? <ErrorNote error={save.error} /> : null}

      <table className="w-full border border-ink-200">
        <thead className="border-b border-ink-200 bg-ink-50">
          <tr>
            <th className="th w-36">Carton</th>
            <th className="th">Colour</th>
            <th className="th">Size</th>
            <th className="th w-28 text-right">Quantity</th>
            <th className="th w-10" />
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="p-1">
                <input className="input border-transparent bg-transparent" value={r.cartonNumber}
                  onChange={(e) => set(i, { cartonNumber: e.target.value })} />
              </td>
              <td className="p-1">
                <ComboSelect className="input border-transparent bg-transparent" value={r.orderColorId}
                  onChange={(e) => set(i, { orderColorId: e.target.value })}>
                  {colors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </ComboSelect>
              </td>
              <td className="p-1">
                <ComboSelect className="input border-transparent bg-transparent" value={r.orderSizeId}
                  onChange={(e) => set(i, { orderSizeId: e.target.value })}>
                  {sizes.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                </ComboSelect>
              </td>
              <td className="p-1">
                <input className="input tnum border-transparent bg-transparent text-right" value={r.qty || ''}
                  onChange={(e) => set(i, { qty: Number(e.target.value) || 0 })} />
              </td>
              <td className="p-1 text-right">
                <button type="button" className="btn-ghost btn-sm text-red-600"
                  onClick={() => setRows(rows.filter((_, n) => n !== i))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-ink-200 bg-ink-50">
          <tr>
            <td colSpan={3} className="td text-right font-medium">
              {packed.length} carton{packed.length === 1 ? '' : 's'}
            </td>
            <td className="td tnum text-right font-semibold"><Num value={total || null} places={0} /></td>
            <td />
          </tr>
        </tfoot>
      </table>

      <div className="flex justify-end gap-2">
        <p className="mr-auto self-center text-xs text-ink-500">
          Rows with no quantity are skipped.
        </p>
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={save.isPending || packed.length === 0}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : `Pack ${packed.length} carton${packed.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
