/**
 * A Main Order grid that can be edited before it exists: colours, sizes and
 * pieces. Used on the import review screen and on an order whose Main Order
 * is still empty.
 */

import type React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Card, CardHeader, clsx } from './ui';

/** The Main Order grid as the review screen edits it. */
export interface GridDraft { sizes: string[]; rows: Array<{ color: string; cells: Record<string, number> }> }

/** Blank names dropped, cells kept only for sizes that still exist. */
export function cleanGrid(g: GridDraft): GridDraft {
  const sizes = g.sizes.map((s) => s.trim()).filter(Boolean);
  return {
    sizes,
    rows: g.rows
      .filter((r) => r.color.trim())
      .map((r) => ({
        color: r.color.trim(),
        cells: Object.fromEntries(sizes.map((s, i) => [s, r.cells[g.sizes.filter((x) => x.trim())[i]!] ?? 0]).filter(([, q]) => (q as number) > 0)),
      })),
  };
}

export function gridTotal(g: GridDraft): number {
  return g.rows.reduce((a, r) => a + g.sizes.reduce((b, s) => b + (r.cells[s] ?? 0), 0), 0);
}

/**
 * The Main Order grid, editable. Whatever the file did or did not yield, the
 * coordinator can add a colour, a size or a quantity here, so the order is
 * never created with an empty Main Order and Cut Order.
 */
export function GridEditor({ grid, edited, onChange, onReset, title, emptyHint, footer }: {
  grid: GridDraft; edited: boolean; onChange: (g: GridDraft) => void; onReset: () => void;
  title?: string; emptyHint?: string; footer?: React.ReactNode;
}) {
  const total = gridTotal(grid);
  const setCell = (ri: number, size: string, raw: string) => {
    const n = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw)));
    if (!Number.isFinite(n)) return;
    onChange({ ...grid, rows: grid.rows.map((r, i) => (i === ri ? { ...r, cells: { ...r.cells, [size]: n } } : r)) });
  };
  const renameSize = (si: number, name: string) => {
    const old = grid.sizes[si]!;
    onChange({
      sizes: grid.sizes.map((s, i) => (i === si ? name : s)),
      rows: grid.rows.map((r) => {
        const cells = { ...r.cells };
        if (old in cells) { cells[name] = cells[old]!; delete cells[old]; }
        return { ...r, cells };
      }),
    });
  };
  return (
    <Card>
      <CardHeader
        title={title ?? 'Main Order quantities'}
        subtitle={total > 0
          ? 'As it will be created. Correct any cell, colour or size here; the Cut Order is calculated from this grid.'
          : emptyHint ?? 'No quantities could be read from this file. Enter the colours, sizes and pieces from the PO here; the Cut Order is calculated from them.'}
        action={edited ? <button className="btn-secondary btn-sm" onClick={onReset}>Undo my changes</button> : undefined}
      />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              <th className="th">Colour</th>
              {grid.sizes.map((s, si) => (
                <th key={si} className="th text-right">
                  <input aria-label="Size" className="input !w-20 !py-0.5 text-right text-xs font-semibold" value={s} placeholder="Size"
                    onChange={(e) => renameSize(si, e.target.value)} />
                </th>
              ))}
              <th className="th">
                <button className="btn-secondary btn-sm" onClick={() => onChange({ ...grid, sizes: [...grid.sizes, grid.sizes.length === 0 ? 'One Size' : ''] })}>
                  <Plus className="h-3.5 w-3.5" /> Size
                </button>
              </th>
              <th className="th text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {grid.rows.map((r, ri) => (
              <tr key={ri}>
                <td className="td">
                  <div className="flex items-center gap-1.5">
                    <button aria-label="Remove colour" className="text-ink-400 hover:text-red-600"
                      onClick={() => onChange({ ...grid, rows: grid.rows.filter((_, i) => i !== ri) })}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <input aria-label="Colour" className="input !py-0.5 text-sm font-medium" value={r.color} placeholder="Colour"
                      onChange={(e) => onChange({ ...grid, rows: grid.rows.map((x, i) => (i === ri ? { ...x, color: e.target.value } : x)) })} />
                  </div>
                </td>
                {grid.sizes.map((s, si) => (
                  <td key={si} className="td text-right">
                    <input aria-label={`${r.color} ${s}`} inputMode="numeric" className="input !w-20 !py-0.5 text-right tnum"
                      value={r.cells[s] ? String(r.cells[s]) : ''} placeholder="0"
                      onChange={(e) => setCell(ri, s, e.target.value.replace(/[^\d]/g, ''))} />
                  </td>
                ))}
                <td className="td" />
                <td className="td tnum text-right font-semibold">
                  {grid.sizes.reduce((a, s) => a + (r.cells[s] ?? 0), 0).toLocaleString()}
                </td>
              </tr>
            ))}
            <tr>
              <td className="td" colSpan={grid.sizes.length + 3}>
                <button className="btn-secondary btn-sm"
                  onClick={() => onChange({ sizes: grid.sizes.length === 0 ? ['One Size'] : grid.sizes, rows: [...grid.rows, { color: '', cells: {} }] })}>
                  <Plus className="h-3.5 w-3.5" /> Colour
                </button>
              </td>
            </tr>
          </tbody>
          <tfoot className="border-t-2 border-ink-300 bg-ink-50">
            <tr>
              <td className="td font-semibold">Total</td>
              {grid.sizes.map((s, si) => (
                <td key={si} className="td tnum text-right font-semibold">
                  {grid.rows.reduce((a, r) => a + (r.cells[s] ?? 0), 0).toLocaleString()}
                </td>
              ))}
              <td className="td" />
              <td className={clsx('td tnum text-right font-bold', total === 0 && 'text-red-700')}>{total.toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {footer}
    </Card>
  );
}

