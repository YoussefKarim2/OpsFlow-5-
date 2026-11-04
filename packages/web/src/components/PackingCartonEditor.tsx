/**
 * A packing file's cartons, corrected by hand.
 *
 * Everything on a carton card can be changed: the carton number, how many
 * cartons the line stands for, each colour in it and its pieces by size, the
 * weights and the measurement. Cartons and colours can be added and removed,
 * and sizes added. The corrections are kept beside the file; the file itself
 * is never changed, and "Back to the file" shows its own reading again.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, ApiError, type EditedPackingCarton, type PackingFileLayoutDto } from '../lib/api';
import { ComboSelect } from './ComboSelect';
import { clsx, useToast } from './ui';
import { readTypedNumber } from '@opsflow/shared';

interface Line { key: number; colour: string; style: string; bySize: Record<string, string> }
interface Box { key: number; number: string; count: string; grossKg: string; netKg: string; measurement: string; lines: Line[] }

let nextKey = 1;
const str = (n: number | null | undefined): string => (n == null ? '' : String(n));
/**
 * A typed figure: blank is nothing, anything else must be a number of at least
 * 0. Read by the shared rule — a comma only between thousands — so "12,5" kg
 * is refused instead of saved as 125 (commas used to be stripped wholesale).
 */
const figure = (s: string): number | null | 'bad' => {
  const r = readTypedNumber(s);
  if (!r.ok) return 'bad';
  return r.value == null || r.value >= 0 ? r.value : 'bad';
};
/** Why a typed figure was refused, for the error list. */
const why = (s: string): string => {
  const r = readTypedNumber(s);
  return !r.ok && s.includes(',') ? `: ${r.reason.replace(/\.$/, '')}` : '';
};

function toBoxes(data: PackingFileLayoutDto): Box[] {
  const boxes: Box[] = [];
  for (const c of data.layout.cartons) {
    const line: Line = {
      key: nextKey++, colour: c.colour ?? '', style: c.style ?? '',
      bySize: Object.fromEntries(Object.entries(c.bySize).map(([s, n]) => [s, str(n)])),
    };
    if (c.continues && boxes.length > 0) { boxes[boxes.length - 1]!.lines.push(line); continue; }
    boxes.push({
      key: nextKey++, number: c.number, count: str(c.count),
      grossKg: str(c.grossKg), netKg: str(c.netKg), measurement: c.measurement ?? '', lines: [line],
    });
  }
  return boxes;
}

export function PackingCartonEditor({
  orderId, attachmentId, data, sizeName, onDone,
}: {
  orderId: string;
  attachmentId: string;
  data: PackingFileLayoutDto;
  sizeName: (s: string) => string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [boxes, setBoxes] = useState<Box[]>(() => toBoxes(data));
  const [sizes, setSizes] = useState<string[]>(() => {
    const list = [...(data.layout.table?.sizes ?? [])];
    for (const c of data.layout.cartons) for (const s of Object.keys(c.bySize)) if (!list.includes(s)) list.push(s);
    return list;
  });
  const [newSize, setNewSize] = useState('');

  const setBox = (key: number, patch: Partial<Box>) => setBoxes((bs) => bs.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  const setLine = (boxKey: number, lineKey: number, patch: Partial<Line>) =>
    setBoxes((bs) => bs.map((b) => (b.key !== boxKey ? b : { ...b, lines: b.lines.map((l) => (l.key === lineKey ? { ...l, ...patch } : l)) })));
  const blankLine = (colour = ''): Line => ({ key: nextKey++, colour, style: '', bySize: {} });

  const addCarton = () => setBoxes((bs) => {
    // The next number after the highest one written, as a carton list counts on.
    const top = Math.max(0, ...bs.map((b) => Number((b.number.match(/(\d+)\s*$/) ?? [])[1] ?? 0)));
    return [...bs, { key: nextKey++, number: String(top + 1), count: '1', grossKg: '', netKg: '', measurement: '', lines: [blankLine(bs[bs.length - 1]?.lines[0]?.colour ?? '')] }];
  });

  // Every figure read once, so the totals and the save agree.
  const checked = useMemo(() => {
    const errors: string[] = [];
    let cartons = 0; let pieces = 0;
    boxes.forEach((b, i) => {
      const name = b.number.trim() ? `Carton ${b.number.trim()}` : `Carton line ${i + 1}`;
      const count = figure(b.count);
      if (count === 'bad' || count == null || count === 0) errors.push(`${name}: the number of cartons must be more than 0.`);
      for (const [label, v] of [['gross weight', b.grossKg], ['net weight', b.netKg]] as const) {
        if (figure(v) === 'bad') errors.push(`${name}: the ${label} is not a number${why(v)}.`);
      }
      const g = figure(b.grossKg); const n = figure(b.netKg);
      if (typeof g === 'number' && typeof n === 'number' && n > g) errors.push(`${name}: the net weight is more than the gross weight.`);
      let perBox = 0;
      for (const l of b.lines) for (const s of sizes) {
        const q = figure(l.bySize[s] ?? '');
        if (q === 'bad') errors.push(`${name}${l.colour ? `, ${l.colour}` : ''}: ${sizeName(s)} is not a number${why(l.bySize[s] ?? '')}.`);
        else if (q != null) perBox += q;
      }
      const c = typeof count === 'number' ? count : 0;
      cartons += c; pieces += perBox * c;
    });
    return { errors, cartons, pieces };
  }, [boxes, sizes, sizeName]);

  const save = useMutation({
    mutationFn: () => {
      const cartons: EditedPackingCarton[] = [];
      for (const b of boxes) {
        b.lines.forEach((l, i) => {
          const bySize: Record<string, number> = {};
          for (const s of sizes) { const q = figure(l.bySize[s] ?? ''); if (typeof q === 'number' && q > 0) bySize[s] = q; }
          const g = figure(b.grossKg); const n = figure(b.netKg);
          cartons.push({
            number: b.number.trim(), count: Number(figure(b.count)), colour: l.colour.trim() || null, style: l.style.trim() || null, bySize,
            grossKg: typeof g === 'number' ? g : null, netKg: typeof n === 'number' ? n : null,
            measurement: b.measurement.trim() || null, ...(i > 0 ? { continues: true } : {}),
          });
        });
      }
      return api.packing.saveFileCartons(orderId, attachmentId, cartons, data.edited?.at ?? null);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['packing-file-layout', orderId, attachmentId] });
      toast.success('Cartons saved');
      onDone();
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : 'The cartons could not be saved');
      if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: ['packing-file-layout', orderId, attachmentId] });
    },
  });

  const input = 'input h-8 px-2 text-sm';
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ink-50 px-3 py-2 text-sm">
        <span className="tnum text-ink-700">
          <strong className="text-ink-900">{checked.cartons.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong> cartons ·{' '}
          <strong className="text-ink-900">{checked.pieces.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong> pcs
        </span>
        <div className="flex items-center gap-1.5">
          <div className="w-36">
            <ComboSelect
              aria-label="Add a size"
              allowCustom
              className={input}
              placeholder="Add a size…"
              value={newSize}
              onChange={(e) => {
                const s = e.target.value.trim();
                setNewSize('');
                if (s && !sizes.includes(s)) setSizes((list) => [...list, s]);
              }}
            >
              {data.order.sizes.filter((s) => !sizes.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
            </ComboSelect>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {boxes.map((b) => {
          const count = figure(b.count);
          return (
            <div key={b.key} className="rounded-md border border-ink-200 bg-white">
              <div className="flex flex-wrap items-end gap-2 border-b border-ink-100 bg-ink-50 px-3 py-2">
                <label className="text-2xs font-medium uppercase tracking-wide text-ink-500">
                  Carton no.
                  <input className={clsx(input, 'mt-0.5 block w-28')} value={b.number} placeholder="e.g. 1-10" onChange={(e) => setBox(b.key, { number: e.target.value })} />
                </label>
                <label className="text-2xs font-medium uppercase tracking-wide text-ink-500">
                  Cartons
                  <input className={clsx(input, 'tnum mt-0.5 block w-20', (count === 'bad' || !count) && 'border-red-400')} inputMode="decimal" value={b.count} onChange={(e) => setBox(b.key, { count: e.target.value })} />
                </label>
                <label className="text-2xs font-medium uppercase tracking-wide text-ink-500">
                  G.W. kg
                  <input className={clsx(input, 'tnum mt-0.5 block w-20', figure(b.grossKg) === 'bad' && 'border-red-400')} inputMode="decimal" value={b.grossKg} onChange={(e) => setBox(b.key, { grossKg: e.target.value })} />
                </label>
                <label className="text-2xs font-medium uppercase tracking-wide text-ink-500">
                  N.W. kg
                  <input className={clsx(input, 'tnum mt-0.5 block w-20', figure(b.netKg) === 'bad' && 'border-red-400')} inputMode="decimal" value={b.netKg} onChange={(e) => setBox(b.key, { netKg: e.target.value })} />
                </label>
                <label className="text-2xs font-medium uppercase tracking-wide text-ink-500">
                  Measurement
                  <input className={clsx(input, 'mt-0.5 block w-32')} value={b.measurement} onChange={(e) => setBox(b.key, { measurement: e.target.value })} />
                </label>
                <button
                  type="button"
                  className="btn-ghost btn-sm ml-auto text-red-600"
                  title="Remove this carton"
                  onClick={() => setBoxes((bs) => bs.filter((x) => x.key !== b.key))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-2xs uppercase tracking-wide text-ink-500">
                      <th className="px-3 py-1.5 font-medium">Colour</th>
                      {sizes.map((s) => <th key={s} className="px-1 py-1.5 text-center font-medium">{sizeName(s)}</th>)}
                      <th className="px-2 py-1.5 text-right font-medium">Pcs</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {b.lines.map((l) => {
                      const pcs = sizes.reduce((a, s) => { const q = figure(l.bySize[s] ?? ''); return a + (typeof q === 'number' ? q : 0); }, 0);
                      return (
                        <tr key={l.key}>
                          <td className="px-3 py-1.5">
                            <div className="w-44">
                              <ComboSelect
                                aria-label="Colour"
                                allowCustom
                                className={input}
                                placeholder="Colour"
                                value={l.colour}
                                onChange={(e) => setLine(b.key, l.key, { colour: e.target.value })}
                              >
                                {data.order.colours.map((c) => <option key={c} value={c}>{c}</option>)}
                              </ComboSelect>
                            </div>
                          </td>
                          {sizes.map((s) => (
                            <td key={s} className="px-1 py-1.5">
                              <input
                                aria-label={`${sizeName(s)} pieces`}
                                className={clsx(input, 'tnum w-16 text-center', figure(l.bySize[s] ?? '') === 'bad' && 'border-red-400')}
                                inputMode="decimal"
                                value={l.bySize[s] ?? ''}
                                onChange={(e) => setLine(b.key, l.key, { bySize: { ...l.bySize, [s]: e.target.value } })}
                              />
                            </td>
                          ))}
                          <td className="tnum px-2 py-1.5 text-right text-ink-700">{pcs.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                          <td className="px-1 py-1.5">
                            {b.lines.length > 1 && (
                              <button
                                type="button"
                                className="btn-ghost btn-sm text-ink-500"
                                title="Remove this colour from the carton"
                                onClick={() => setBox(b.key, { lines: b.lines.filter((x) => x.key !== l.key) })}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-ink-100 px-3 py-1.5">
                <button type="button" className="btn-ghost btn-sm" onClick={() => setBox(b.key, { lines: [...b.lines, blankLine()] })}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add a colour to this carton
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button type="button" className="btn-secondary btn-sm" onClick={addCarton}>
        <Plus className="mr-1 h-3.5 w-3.5" /> Add a carton
      </button>

      {checked.errors.length > 0 && (
        <ul className="space-y-0.5 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {checked.errors.slice(0, 6).map((e) => <li key={e}>{e}</li>)}
          {checked.errors.length > 6 && <li>…and {checked.errors.length - 6} more.</li>}
        </ul>
      )}

      <div className="flex justify-end gap-2 border-t border-ink-100 pt-3">
        <button type="button" className="btn-secondary btn-sm" onClick={onDone} disabled={save.isPending}>Cancel</button>
        <button
          type="button"
          className="btn-primary btn-sm"
          onClick={() => save.mutate()}
          disabled={save.isPending || checked.errors.length > 0}
        >
          {save.isPending ? 'Saving…' : 'Save cartons'}
        </button>
      </div>
    </div>
  );
}
