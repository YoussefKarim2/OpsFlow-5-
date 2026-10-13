/**
 * The lay plan, editable in place.
 *
 * The table on the Laying & Marker screen is what the cutting floor works
 * from, and most of it arrives by import. This is how a row gets corrected
 * — a layer count, a marker length, a ratio typed differently from the sheet
 * — or a lay added or removed without re-importing. The whole table is
 * edited and saved once, the Bill of Materials pattern, so a half-finished
 * correction is never saved by accident.
 *
 * Numbers are held as typed and parsed on save, so "2." and "0.35" can be
 * typed at all. Pieces per lay are shown live from the ratio and the layer
 * count, with the same parser the plan uses.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save } from 'lucide-react';
import { isTypeableNumber, parseSizeRatio } from '@opsflow/shared';
import { api, ApiError, type LayDraftDto } from '../lib/api';
import { clsx } from './ui';

export interface LayRowInput {
  id: string; markerNumber?: string | null; fabric: string; color: string; panel: string; ratio: string;
  layers: number; markerLengthM: number; totalLengthM: number; nestPcs: number | null;
  efficiencyPct?: number | null; maxLayer?: number | null; notes?: string | null;
}

interface Draft {
  id?: string; markerNumber: string; fabric: string; color: string; panel: string; ratio: string;
  layers: string; markerLengthM: string; totalLengthM: string; nestPcs: string; efficiencyPct: string; maxLayer: string;
}

const text = (v: number | null | undefined) => (v == null ? '' : String(v));
const num = (t: string): number | null => { const s = t.trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const unreadable = (t: string) => t.trim() !== '' && num(t) == null;

const toDraft = (l: LayRowInput): Draft => ({
  id: l.id, markerNumber: l.markerNumber ?? '', fabric: l.fabric, color: l.color ?? '', panel: l.panel || 'ALL', ratio: l.ratio,
  layers: text(l.layers), markerLengthM: text(l.markerLengthM), totalLengthM: text(l.totalLengthM || null),
  nestPcs: text(l.nestPcs), efficiencyPct: text(l.efficiencyPct), maxLayer: text(l.maxLayer),
});
const blank = (fabric: string): Draft => ({
  markerNumber: '', fabric, color: '', panel: 'ALL', ratio: '', layers: '', markerLengthM: '', totalLengthM: '', nestPcs: '', efficiencyPct: '', maxLayer: '',
});

const pieces = (d: Draft) => Object.values(parseSizeRatio(d.ratio)).reduce((a, b) => a + b, 0) * (num(d.layers) ?? 0);

export function LayPlanEditor({ orderId, lays, defaultFabric, onSaved, onCancel }: {
  orderId: string; lays: LayRowInput[]; defaultFabric: string | null; onSaved: () => void; onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Draft[]>(() => lays.map(toDraft));
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.materials.saveMarkers(orderId, {
      removeIds: removed,
      items: rows.map((d): LayDraftDto => ({
        id: d.id, markerNumber: d.markerNumber.trim() || null, fabricName: d.fabric.trim(), fabricColor: d.color.trim() || null,
        panel: d.panel.trim() || 'ALL', sizeRatio: d.ratio.trim(), layers: Math.round(num(d.layers) ?? 0), markerLengthM: num(d.markerLengthM) ?? 0,
        totalLengthM: num(d.totalLengthM), nestPcs: num(d.nestPcs) == null ? null : Math.round(num(d.nestPcs)!),
        efficiencyPct: num(d.efficiencyPct), maxLayer: num(d.maxLayer) == null ? null : Math.round(num(d.maxLayer)!),
      })),
    }),
    onSuccess: () => {
      setError(null);
      for (const k of ['markers', 'order', 'order-steps']) void qc.invalidateQueries({ queryKey: [k, orderId] });
      onSaved();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the lay plan.'),
  });

  const set = (i: number, patch: Partial<Draft>) => setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const numeric = (apply: (v: string) => void) => (e: { target: { value: string } }) => { if (isTypeableNumber(e.target.value)) apply(e.target.value); };
  const remove = (i: number) => { const r = rows[i]!; if (r.id) setRemoved((x) => [...x, r.id!]); setRows((rs) => rs.filter((_, n) => n !== i)); };

  const unnamed = rows.some((r) => !r.fabric.trim() || !r.ratio.trim());
  const halfTyped = rows.some((r) => [r.layers, r.markerLengthM, r.totalLengthM, r.nestPcs, r.efficiencyPct, r.maxLayer].some(unreadable));
  const invalid = unnamed || halfTyped;
  const totalPieces = rows.reduce((a, r) => a + pieces(r), 0);

  const cell = 'input border-transparent bg-transparent !py-1';
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-500">Change any cell. Pieces are worked out from the ratio and the layers as you type.</span>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setRows([...rows, blank(defaultFabric ?? rows[rows.length - 1]?.fabric ?? '')])}>
            <Plus className="h-3.5 w-3.5" /> Add a lay
          </button>
          <button type="button" className="btn-secondary btn-sm" onClick={onCancel} disabled={save.isPending}>Cancel</button>
          <button type="button" className="btn-primary btn-sm" disabled={save.isPending || invalid}
            title={unnamed ? 'Every lay needs a fabric and a size ratio' : halfTyped ? 'Finish the number being typed' : undefined}
            onClick={() => save.mutate()}>
            <Save className="h-3.5 w-3.5" /> {save.isPending ? 'Saving…' : 'Save lay plan'}
          </button>
        </div>
      </div>
      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full border border-ink-200">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              <th className="th w-8">#</th>
              <th className="th min-w-[9rem]">Fabric</th>
              <th className="th min-w-[7rem]">Colour</th>
              <th className="th w-24">Panel</th>
              <th className="th min-w-[16rem]">Size ratio</th>
              <th className="th w-20 text-right">Layers</th>
              <th className="th w-20 text-right">Pieces</th>
              <th className="th w-24 text-right">Marker (m)</th>
              <th className="th w-24 text-right">Total (m)</th>
              <th className="th w-16 text-right">Nest</th>
              <th className="th w-16 text-right">Eff %</th>
              <th className="th w-20 text-right">Max layer</th>
              <th className="th w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.length === 0 && (
              <tr><td colSpan={13} className="td py-6 text-center text-ink-500">No lays. Add one, or import a laying sheet.</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.id ?? `new-${i}`}>
                <td className="td tnum text-ink-400">{i + 1}</td>
                <td className="p-1"><input aria-label={`Lay ${i + 1} fabric`} className={clsx(cell, !r.fabric.trim() && 'ring-1 ring-red-400')} value={r.fabric} onChange={(e) => set(i, { fabric: e.target.value })} /></td>
                <td className="p-1"><input aria-label={`Lay ${i + 1} colour`} className={cell} value={r.color} onChange={(e) => set(i, { color: e.target.value })} /></td>
                <td className="p-1"><input aria-label={`Lay ${i + 1} panel`} className={cell} value={r.panel} onChange={(e) => set(i, { panel: e.target.value })} /></td>
                <td className="p-1"><input aria-label={`Lay ${i + 1} ratio`} className={clsx(cell, 'font-mono text-2xs', !r.ratio.trim() && 'ring-1 ring-red-400')} placeholder="(YS2), (YM2), (YL1)" value={r.ratio} onChange={(e) => set(i, { ratio: e.target.value })} /></td>
                <td className="p-1"><input aria-label={`Lay ${i + 1} layers`} inputMode="numeric" className={clsx(cell, 'tnum text-right')} value={r.layers} onChange={numeric((v) => set(i, { layers: v }))} /></td>
                <td className="td tnum text-right font-semibold">{pieces(r).toLocaleString()}</td>
                <td className="p-1"><input aria-label={`Lay ${i + 1} marker length`} inputMode="decimal" className={clsx(cell, 'tnum text-right')} value={r.markerLengthM} onChange={numeric((v) => set(i, { markerLengthM: v }))} /></td>
                <td className="p-1"><input aria-label={`Lay ${i + 1} total length`} inputMode="decimal" className={clsx(cell, 'tnum text-right')} placeholder="—" value={r.totalLengthM} onChange={numeric((v) => set(i, { totalLengthM: v }))} /></td>
                <td className="p-1"><input aria-label={`Lay ${i + 1} nest`} inputMode="numeric" className={clsx(cell, 'tnum text-right')} placeholder="—" value={r.nestPcs} onChange={numeric((v) => set(i, { nestPcs: v }))} /></td>
                <td className="p-1"><input aria-label={`Lay ${i + 1} efficiency`} inputMode="decimal" className={clsx(cell, 'tnum text-right')} placeholder="—" value={r.efficiencyPct} onChange={numeric((v) => set(i, { efficiencyPct: v }))} /></td>
                <td className="p-1"><input aria-label={`Lay ${i + 1} max layer`} inputMode="numeric" className={clsx(cell, 'tnum text-right')} placeholder="—" value={r.maxLayer} onChange={numeric((v) => set(i, { maxLayer: v }))} /></td>
                <td className="p-1 text-right">
                  <button type="button" className="btn-ghost btn-sm text-red-600" title="Remove this lay" onClick={() => remove(i)}><Trash2 className="h-3.5 w-3.5" /></button>
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t border-ink-200 bg-ink-50">
              <tr>
                <td colSpan={5} className="td text-right font-medium">Lay plan produces</td>
                <td className="td tnum text-right font-semibold">{rows.reduce((a, r) => a + (num(r.layers) ?? 0), 0).toLocaleString()}</td>
                <td className="td tnum text-right font-bold">{totalPieces.toLocaleString()}</td>
                <td className="td tnum text-right font-semibold">{rows.reduce((a, r) => a + (num(r.markerLengthM) ?? 0), 0).toFixed(2)}</td>
                <td className="td tnum text-right font-semibold">{Math.round(rows.reduce((a, r) => a + (num(r.totalLengthM) ?? (num(r.layers) ?? 0) * (num(r.markerLengthM) ?? 0)), 0)).toLocaleString()}</td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {removed.length > 0 && <p className="text-xs text-amber-700">{removed.length} lay{removed.length === 1 ? '' : 's'} will be removed when you save.</p>}
    </div>
  );
}
