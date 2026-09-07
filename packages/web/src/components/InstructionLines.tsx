/**
 * The name-and-number table beside a custom instruction's prose.
 *
 * Shirt printing arrives as a list — Ronaldo, 7, L, 2 — and that is a table,
 * not a paragraph. The instruction's own title and body are untouched and still
 * carry everything that reads as a sentence; this is the part that reads as
 * rows, so it can be imported from a spreadsheet column and edited one row at a
 * time instead of being retyped into prose.
 *
 * Every field is optional on purpose. A printing list often has a name and no
 * number, or a number and no name, and refusing the row would mean refusing the
 * sheet the customer actually sent.
 */

import { Plus, Trash2 } from 'lucide-react';
import type { InstructionLineDto } from '../lib/api';
import { Num } from './ui';

export function InstructionLines({
  lines, onChange, readOnly = false,
}: {
  lines: InstructionLineDto[];
  onChange?: (next: InstructionLineDto[]) => void;
  readOnly?: boolean;
}) {
  const set = (i: number, patch: Partial<InstructionLineDto>) =>
    onChange?.(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const total = lines.reduce((a, l) => a + (l.qty ?? 0), 0);

  if (readOnly && lines.length === 0) return null;

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="label mb-0">Names and numbers</span>
        {!readOnly && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => onChange?.([...lines, { name: null, number: null, sizeLabel: null, qty: null, note: null }])}
          >
            <Plus className="h-3.5 w-3.5" /> Add a row
          </button>
        )}
      </div>

      {lines.length === 0 ? (
        <p className="text-xs text-ink-500">
          No names or numbers. Add a row, or import a document that carries them.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border border-ink-200">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Name</th>
                <th className="th w-24">Number</th>
                <th className="th w-24">Size</th>
                <th className="th w-24 text-right">Qty</th>
                <th className="th">Instruction</th>
                {!readOnly && <th className="th w-10" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {lines.map((l, i) => (
                <tr key={i}>
                  {readOnly ? (
                    <>
                      <td className="td">{l.name ?? '—'}</td>
                      <td className="td tnum">{l.number ?? '—'}</td>
                      <td className="td">{l.sizeLabel ?? '—'}</td>
                      <td className="td tnum text-right"><Num value={l.qty} places={0} /></td>
                      <td className="td text-ink-600">{l.note ?? '—'}</td>
                    </>
                  ) : (
                    <>
                      <td className="p-1">
                        <input className="input border-transparent bg-transparent" value={l.name ?? ''}
                          onChange={(e) => set(i, { name: e.target.value || null })} />
                      </td>
                      <td className="p-1">
                        <input className="input tnum border-transparent bg-transparent" value={l.number ?? ''}
                          onChange={(e) => set(i, { number: e.target.value || null })} />
                      </td>
                      <td className="p-1">
                        <input className="input border-transparent bg-transparent" value={l.sizeLabel ?? ''}
                          onChange={(e) => set(i, { sizeLabel: e.target.value || null })} />
                      </td>
                      <td className="p-1">
                        <input className="input tnum border-transparent bg-transparent text-right" value={l.qty ?? ''}
                          onChange={(e) => set(i, { qty: e.target.value === '' ? null : Number(e.target.value) })} />
                      </td>
                      <td className="p-1">
                        <input className="input border-transparent bg-transparent" value={l.note ?? ''}
                          onChange={(e) => set(i, { note: e.target.value || null })} />
                      </td>
                      <td className="p-1 text-right">
                        <button type="button" className="btn-ghost btn-sm text-red-600"
                          onClick={() => onChange?.(lines.filter((_, n) => n !== i))}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
            {total > 0 ? (
              <tfoot className="border-t border-ink-200 bg-ink-50">
                <tr>
                  <td colSpan={3} className="td text-right font-medium">Total pieces</td>
                  <td className="td tnum text-right font-semibold"><Num value={total} places={0} /></td>
                  <td colSpan={readOnly ? 1 : 2} />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
    </div>
  );
}
