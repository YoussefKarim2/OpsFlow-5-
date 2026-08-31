/**
 * The quantity matrix — the brief's section 10.
 *
 * One grid, switchable between the eight ledgers, with totals computed on every
 * render rather than stored. The workbook needed nine side-by-side grids across
 * 146 columns to show the same information; the ledger selector replaces them.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wand2, Save } from 'lucide-react';
import {
  QtyLedger, LEDGER_LABEL, buildMatrix, computeVariances, fmtNumber,
  type OrderDetailDto, type QtyCell, type AxisRef,
} from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Card, CardHeader, Num, Spinner, ErrorNote, clsx } from '../../components/ui';

const EDITABLE: string[] = [
  QtyLedger.ORDER, QtyLedger.STOCK, QtyLedger.IN_LINE,
  QtyLedger.OUT_LINE, QtyLedger.PACKED, QtyLedger.SHIPPED, QtyLedger.SECOND_DEGREE,
];

export function QuantityTab({ order }: { order: OrderDetailDto }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [ledger, setLedger] = useState<string>(QtyLedger.ORDER);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['matrix', order.id],
    queryFn: () => api.orders.matrix(order.id),
  });

  const save = useMutation({
    mutationFn: (cells: Array<{ orderColorId: string; orderSizeId: string; qty: number }>) =>
      api.orders.setMatrix(order.id, ledger, cells),
    onSuccess: () => {
      setEdits({});
      setError(null);
      void qc.invalidateQueries({ queryKey: ['matrix', order.id] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  });

  const generateCut = useMutation({
    mutationFn: () => api.orders.generateCut(order.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['matrix', order.id] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not generate the cut order.'),
  });

  if (isLoading) return <Spinner />;
  if (!data) return null;

  const colors: AxisRef[] = data.colors.map((c) => ({ id: c.id, name: c.name, position: c.position }));
  const sizes: AxisRef[] = data.sizes.map((s) => ({ id: s.id, name: s.name, position: s.position }));

  // Rebuild locally so unsaved edits show live totals — the coordinator sees
  // the effect of a change before committing it, which the workbook did too.
  const baseCells: QtyCell[] = [];
  for (const l of Object.values(QtyLedger)) {
    const m = data.matrices[l];
    if (!m) continue;
    for (const c of colors) for (const s of sizes) {
      const qty = m.cells[c.id]?.[s.id] ?? 0;
      if (qty !== 0) baseCells.push({ colorId: c.id, sizeId: s.id, ledger: l, qty });
    }
  }

  const withEdits: QtyCell[] = baseCells
    .filter((c) => !(c.ledger === ledger && `${c.colorId}:${c.sizeId}` in edits))
    .concat(
      Object.entries(edits).map(([key, qty]) => {
        const [colorId, sizeId] = key.split(':') as [string, string];
        return { colorId, sizeId, ledger: ledger as QtyLedger, qty };
      }),
    );

  const matrix = buildMatrix(withEdits, colors, sizes, ledger as QtyLedger);
  const variances = computeVariances(withEdits);
  const editable = EDITABLE.includes(ledger) && can('order:edit');
  const dirty = Object.keys(edits).length > 0;

  const cellValue = (colorId: string, sizeId: string): number =>
    edits[`${colorId}:${sizeId}`] ?? matrix.cells[colorId]?.[sizeId] ?? 0;

  return (
    <div className="space-y-4 p-5">
      {error && <ErrorNote error={new Error(error)} />}

      <Card>
        <div className="card-header flex-wrap gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {Object.values(QtyLedger).map((l) => {
              const total = data.totals[l] ?? 0;
              return (
                <button
                  key={l}
                  onClick={() => { setLedger(l); setEdits({}); }}
                  className={clsx(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    ledger === l ? 'bg-accent-600 text-white' : 'text-ink-600 hover:bg-ink-100',
                  )}
                >
                  {LEDGER_LABEL[l]}
                  <span className={clsx('tnum ml-1.5', ledger === l ? 'text-accent-100' : 'text-ink-400')}>
                    {fmtNumber(total)}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            {ledger === QtyLedger.CUT && can('cutting:write') && (
              <button
                onClick={() => generateCut.mutate()}
                disabled={generateCut.isPending}
                className="btn-secondary btn-sm"
                title={`ROUNDUP((ordered − stock) × ${(1 + order.cutPercentage).toFixed(2)})`}
              >
                <Wand2 className="h-3.5 w-3.5" />
                {generateCut.isPending ? 'Generating…' : `Regenerate at ${(order.cutPercentage * 100).toFixed(0)}%`}
              </button>
            )}
            {dirty && (
              <>
                <button onClick={() => setEdits({})} className="btn-ghost btn-sm">Discard</button>
                <button
                  onClick={() =>
                    save.mutate(
                      Object.entries(edits).map(([key, qty]) => {
                        const [orderColorId, orderSizeId] = key.split(':') as [string, string];
                        return { orderColorId, orderSizeId, qty };
                      }),
                    )
                  }
                  disabled={save.isPending}
                  className="btn-primary btn-sm"
                >
                  <Save className="h-3.5 w-3.5" />
                  {save.isPending ? 'Saving…' : `Save ${Object.keys(edits).length} change${Object.keys(edits).length === 1 ? '' : 's'}`}
                </button>
              </>
            )}
          </div>
        </div>

        {ledger === QtyLedger.CUT && (
          <p className="border-b border-ink-200 bg-blue-50 px-4 py-2 text-xs text-blue-800">
            The cut quantity is calculated, not typed:
            <code className="mx-1 rounded bg-white px-1 py-0.5 font-mono text-2xs">
              ROUNDUP((ordered − stock) × {(1 + order.cutPercentage).toFixed(2)})
            </code>
            per cell. Change the order, the stock or the cut percentage and regenerate.
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50">
                <th className="sticky left-0 z-10 bg-ink-50 px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-ink-500">
                  Colour
                </th>
                {matrix.sizes.map((s) => (
                  <th key={s.id} className="px-2 py-2 text-center text-2xs font-semibold uppercase tracking-wider text-ink-500">
                    {s.name}
                  </th>
                ))}
                <th className="bg-ink-100 px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-ink-600">
                  Total
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {matrix.colors.map((c) => {
                const swatch = data.colors.find((x) => x.id === c.id)?.hex;
                return (
                  <tr key={c.id} className="hover:bg-accent-50/30">
                    <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-1.5 text-sm font-medium text-ink-800">
                      <span className="flex items-center gap-2">
                        {swatch && (
                          <span
                            className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-inset ring-ink-300"
                            style={{ backgroundColor: swatch }}
                          />
                        )}
                        {c.name}
                      </span>
                    </td>
                    {matrix.sizes.map((s) => {
                      const key = `${c.id}:${s.id}`;
                      const v = cellValue(c.id, s.id);
                      const changed = key in edits;
                      return (
                        <td key={s.id} className="px-1 py-1 text-center">
                          {editable ? (
                            <input
                              type="number" min={0} value={v || ''}
                              onChange={(e) => {
                                const n = e.target.value === '' ? 0 : Math.max(0, Number(e.target.value));
                                setEdits((prev) => ({ ...prev, [key]: n }));
                              }}
                              className={clsx(
                                'tnum w-14 rounded border px-1 py-1 text-center text-sm focus:outline-none focus:ring-1 focus:ring-accent-500',
                                changed ? 'border-accent-400 bg-accent-50 font-semibold' : 'border-transparent bg-transparent hover:border-ink-200',
                                v === 0 && 'text-ink-300',
                              )}
                            />
                          ) : (
                            <span className={clsx('tnum text-sm', v === 0 ? 'text-ink-300' : 'text-ink-800')}>
                              {v || '·'}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td className="tnum bg-ink-50 px-3 py-1.5 text-right text-sm font-semibold text-ink-900">
                      {fmtNumber(matrix.rowTotals[c.id] ?? 0)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-ink-300 bg-ink-100">
                <td className="sticky left-0 z-10 bg-ink-100 px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-ink-600">
                  Totals
                </td>
                {matrix.sizes.map((s) => (
                  <td key={s.id} className="tnum px-2 py-2 text-center text-sm font-semibold text-ink-800">
                    {fmtNumber(matrix.colTotals[s.id] ?? 0)}
                  </td>
                ))}
                <td className="tnum bg-ink-200 px-3 py-2 text-right text-base font-bold text-ink-900">
                  {fmtNumber(matrix.grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {/* Stage-to-stage variance — the three shortage grids the workbook stored. */}
      <Card>
        <CardHeader
          title="Stage variance"
          subtitle="Derived from the ledgers above — the workbook stored these as three separate grids"
        />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Transition</th>
                <th className="th text-right">From</th>
                <th className="th text-right">To</th>
                <th className="th text-right">Variance</th>
                <th className="th text-right">Yield</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {variances.map((v) => (
                <tr key={`${v.from}-${v.to}`}>
                  <td className="td font-medium">{v.label}</td>
                  <td className="td text-right"><Num value={v.fromQty} /></td>
                  <td className="td text-right"><Num value={v.toQty} /></td>
                  <td className="td text-right"><Num value={v.variance} kind="variance" /></td>
                  <td className="td text-right"><Num value={v.yieldPct} kind="percent" places={1} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
