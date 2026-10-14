/**
 * The quantity matrix — the brief's section 10.
 *
 * One grid, switchable between the eight ledgers, with totals computed on every
 * render rather than stored. The workbook needed nine side-by-side grids across
 * 146 columns to show the same information; the ledger selector replaces them.
 */

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wand2, Save, FileSearch } from 'lucide-react';
import {
  QtyLedger, LEDGER_LABEL, buildMatrix, fmtNumber, fmtDate,
  ledgerTotal, computeCutOrderTotal, computeCuttableQty,
  type OrderDetailDto, type QtyCell, type AxisRef,
} from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Card, CardHeader, Spinner, ErrorNote, clsx, useToast, ColourSwatch } from '../../components/ui';
import { GridEditor, cleanGrid, gridTotal, type GridDraft } from '../../components/GridEditor';

/**
 * An order whose Main Order is empty — imported before its PO could be read,
 * or created by hand. Two ways to fill it: read the quantities from the PO the
 * order was imported from or has attached, or type the colours, sizes and
 * pieces. Either way the Cut Order is generated from the result.
 */
function EmptyMainOrder({ orderId, colors, sizes }: { orderId: string; colors: string[]; sizes: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const start: GridDraft = {
    sizes: sizes.length > 0 ? sizes : ['One Size'],
    rows: colors.length > 0 ? colors.map((c) => ({ color: c, cells: {} })) : [{ color: '', cells: {} }],
  };
  const [grid, setGrid] = useState<GridDraft>(start);
  const refresh = () => {
    for (const k of ['matrix', 'order', 'order-steps', 'order-stock']) void qc.invalidateQueries({ queryKey: [k, orderId] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
  };
  const fromDocument = useMutation({
    mutationFn: () => api.orders.fillFromDocument(orderId),
    onSuccess: (r) => {
      setError(null);
      toast.success(`Read ${r.pieces.toLocaleString()} pieces from "${r.fileName}". Cut Order: ${r.cut.toLocaleString()}.`);
      for (const w of r.warnings.slice(0, 3)) toast.error(w);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not read the PO.'),
  });
  const enter = useMutation({
    mutationFn: () => api.orders.enterGrid(orderId, cleanGrid(grid)),
    onSuccess: (r) => {
      setError(null);
      toast.success(`Saved ${r.pieces.toLocaleString()} pieces. Cut Order: ${r.cut.toLocaleString()}.`);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the Main Order.'),
  });
  const total = gridTotal(cleanGrid(grid));
  return (
    <div className="space-y-3">
      <Card className="border-amber-300">
        <CardHeader
          title="This order has no Main Order quantities yet"
          subtitle="Read them from the purchase order this order was imported from or has attached, or enter them below. The Cut Order is generated from them."
          action={
            <button className="btn-primary btn-sm" onClick={() => fromDocument.mutate()} disabled={fromDocument.isPending}>
              <FileSearch className="h-3.5 w-3.5" />
              {fromDocument.isPending ? 'Reading the PO…' : 'Read from the attached PO'}
            </button>
          }
        />
        {error && <p className="px-4 pb-3 text-sm text-red-700">{error}</p>}
      </Card>
      <GridEditor
        title="Enter the Main Order"
        emptyHint="Add each colour and size from the PO and type the pieces."
        grid={grid}
        edited={false}
        onChange={setGrid}
        onReset={() => setGrid(start)}
        footer={
          <div className="flex justify-end border-t border-ink-100 p-3">
            <button className="btn-primary btn-sm" onClick={() => enter.mutate()} disabled={enter.isPending || total === 0}>
              <Save className="h-3.5 w-3.5" />
              {enter.isPending ? 'Saving…' : `Save Main Order${total > 0 ? ` (${total.toLocaleString()} pcs)` : ''}`}
            </button>
          </div>
        }
      />
    </div>
  );
}

const EDITABLE: string[] = [
  QtyLedger.ORDER, QtyLedger.STOCK, QtyLedger.IN_LINE,
  QtyLedger.OUT_LINE, QtyLedger.PACKED, QtyLedger.SHIPPED, QtyLedger.SECOND_DEGREE,
];

export function QuantityTab({
  order, ledger: ledgerParam, onLedgerChange,
}: {
  order: OrderDetailDto;
  /** Which grid to open on, from the URL — Main Order and Cut Order share this tab. */
  ledger?: string | null;
  onLedgerChange?: (ledger: string) => void;
}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [ledger, setLedgerState] = useState<string>(ledgerParam ?? QtyLedger.ORDER);

  // Jumping between the Main Order and Cut Order steps while already on this
  // tab changes only the URL, so the grid has to follow it.
  useEffect(() => {
    if (ledgerParam && ledgerParam !== ledger) {
      setLedgerState(ledgerParam);
      setEdits({});
    }
  }, [ledgerParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLedger = (next: string) => {
    setLedgerState(next);
    onLedgerChange?.(next);
  };
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  /** Null until the allowance is touched, so the order's own value stays authoritative. */
  const [pctDraft, setPctDraft] = useState<string | null>(null);

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
      // Stock entered here is the same stock the Stock step lists, and either
      // one moves the cut order, so neither screen is left showing the old
      // figure.
      void qc.invalidateQueries({ queryKey: ['order-stock', order.id] });
      void qc.invalidateQueries({ queryKey: ['order-steps', order.id] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  });

  const saveCutPct = useMutation({
    mutationFn: (pct: number) => api.orders.update(order.id, { cutPercentage: pct }),
    onSuccess: () => {
      setPctDraft(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the cut allowance.'),
  });

  /** Null until the date is touched, so the order's own value stays authoritative. */
  const [fabricDateDraft, setFabricDateDraft] = useState<string | null>(null);
  const fabricDateSaved = order.fabricDeliveryToSupplier?.slice(0, 10) ?? '';
  const fabricDateText = fabricDateDraft ?? fabricDateSaved;
  const fabricDateDirty = fabricDateDraft !== null && fabricDateDraft !== fabricDateSaved;
  const saveFabricDate = useMutation({
    mutationFn: (date: string) => api.orders.update(order.id, { fabricDeliveryToSupplier: date || null }),
    onSuccess: () => {
      setFabricDateDraft(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the fabric date.'),
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
  const editable = EDITABLE.includes(ledger) && can('order:edit');
  const dirty = Object.keys(edits).length > 0;

  // Main Order → allowance → Cut Order, recomputed on every keystroke so the
  // figure on screen always matches the percentage in the box. The Main Order
  // total is read from the ORDER ledger and never written back.
  const mainOrderQty = ledgerTotal(withEdits, QtyLedger.ORDER);
  // Finished stock already covers part of the order and is not cut again, so
  // the figure above the grid is netted exactly the way the grid itself is.
  // With nothing in stock this is simply the order quantity.
  const cuttableQty = computeCuttableQty(withEdits, colors, sizes);
  // The stock that actually covers an ordered cell, not everything on the
  // shelf: spare pieces of a size nobody ordered do not reduce the cut, so
  // showing them in the subtraction would make the arithmetic not add up.
  const stockQty = mainOrderQty - cuttableQty;
  const pctText = pctDraft ?? String(Number((order.cutPercentage * 100).toFixed(4)));
  const pctParsed = Number(pctText);
  const pctValid = Number.isFinite(pctParsed) && pctParsed >= 0 && pctParsed <= 50;
  const cutPct = pctValid ? pctParsed / 100 : order.cutPercentage;
  const cutOrderQty = computeCutOrderTotal(cuttableQty, cutPct);
  const savedCutQty = ledgerTotal(baseCells, QtyLedger.CUT);
  const pctDirty = pctDraft !== null && Math.abs(cutPct - order.cutPercentage) > 1e-9;

  const cellValue = (colorId: string, sizeId: string): number =>
    edits[`${colorId}:${sizeId}`] ?? matrix.cells[colorId]?.[sizeId] ?? 0;

  return (
    <div className="space-y-4 p-5">
      {error && <ErrorNote error={new Error(error)} />}

      {(data.totals[QtyLedger.ORDER] ?? 0) === 0 && can('order:edit') && (
        <EmptyMainOrder orderId={order.id} colors={colors.map((c) => c.name)} sizes={sizes.map((z) => z.name)} />
      )}

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
                title={`ROUNDUP(main order × ${(1 + order.cutPercentage).toFixed(4)}), shared across the grid`}
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
          <div className="border-b border-ink-200">
            <div className="grid grid-cols-1 gap-px bg-ink-200 sm:grid-cols-2 lg:grid-cols-4">
              <div className="bg-white px-4 py-3">
                <div className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
                  Main Order Quantity
                </div>
                <div className="tnum mt-1 text-xl font-semibold text-ink-900">
                  {fmtNumber(mainOrderQty)}
                  <span className="ml-1 text-xs font-normal text-ink-500">pcs</span>
                </div>
                <div className="mt-0.5 text-2xs text-ink-400">The customer's original quantity</div>
              </div>

              <div className="bg-white px-4 py-3">
                <div className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
                  Cut Allowance
                </div>
                {can('order:edit') ? (
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      type="number" min={0} max={50} step={0.1} value={pctText}
                      onChange={(e) => setPctDraft(e.target.value)}
                      aria-label="Cut allowance percentage"
                      className={clsx(
                        'tnum w-20 rounded-md border px-2 py-1 text-lg font-semibold',
                        pctValid ? 'border-ink-300' : 'border-red-400 bg-red-50',
                      )}
                    />
                    <span className="text-sm text-ink-500">%</span>
                    {pctDirty && pctValid && (
                      <button
                        onClick={() => saveCutPct.mutate(cutPct)}
                        disabled={saveCutPct.isPending}
                        className="btn-primary btn-sm ml-1"
                      >
                        {saveCutPct.isPending ? 'Saving…' : 'Save'}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="tnum mt-1 text-xl font-semibold text-ink-900">
                    {(order.cutPercentage * 100).toFixed(1)}%
                  </div>
                )}
                <div className="mt-0.5 text-2xs text-ink-400">
                  {pctValid ? 'The extra the factory cuts on top' : 'Enter a percentage between 0 and 50'}
                </div>
              </div>

              <div className="bg-white px-4 py-3">
                <div className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
                  Cut Order Quantity
                </div>
                <div className="tnum mt-1 text-xl font-semibold text-accent-700">
                  {fmtNumber(cutOrderQty)}
                  <span className="ml-1 text-xs font-normal text-ink-500">pcs</span>
                </div>
                {/* The arithmetic, shown. With stock recorded the subtraction
                    is named, so the figure is never a number nobody can trace. */}
                <div className="mt-0.5 text-2xs text-ink-400">
                  Calculated — {stockQty > 0
                    ? `(${fmtNumber(mainOrderQty)} − ${fmtNumber(stockQty)} in stock) × `
                    : `${fmtNumber(mainOrderQty)} × `}
                  {(1 + cutPct).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}
                </div>
              </div>

              {/* The same date as "Fabric delivery date to supplier" on the
                  External Order step: one field, so the two never disagree. */}
              <div className="bg-white px-4 py-3">
                <div className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
                  Fabric Date to External
                </div>
                {can('order:edit') ? (
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      type="date" value={fabricDateText}
                      onChange={(e) => setFabricDateDraft(e.target.value)}
                      aria-label="Fabric date to external"
                      className="rounded-md border border-ink-300 px-2 py-1 text-sm font-semibold"
                    />
                    {fabricDateDirty && (
                      <button
                        onClick={() => saveFabricDate.mutate(fabricDateText)}
                        disabled={saveFabricDate.isPending}
                        className="btn-primary btn-sm"
                      >
                        {saveFabricDate.isPending ? 'Saving…' : 'Save'}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="mt-1 text-lg font-semibold text-ink-900">
                    {order.fabricDeliveryToSupplier ? fmtDate(order.fabricDeliveryToSupplier) : '—'}
                  </div>
                )}
                <div className="mt-0.5 text-2xs text-ink-400">When the fabric goes to the external factory</div>
              </div>
            </div>

            <p className="bg-blue-50 px-4 py-2 text-xs text-blue-800">
              The cut quantity is calculated, not typed:
              <code className="mx-1 rounded bg-white px-1 py-0.5 font-mono text-2xs">
                ROUNDUP(main order × (1 + {cutPct.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}))
              </code>
              rounded up once to whole pieces. The grid below is shared out to sum to exactly
              that total. The Main Order itself is never changed.
            </p>

            {savedCutQty === 0 ? (
              <p className="bg-amber-50 px-4 py-2 text-xs text-amber-800">
                No cut order has been generated yet — the grid below is empty.
                Use <strong>Regenerate</strong> to create it.
              </p>
            ) : savedCutQty !== cutOrderQty ? (
              <p className="bg-amber-50 px-4 py-2 text-xs text-amber-800">
                The saved breakdown totals <strong className="tnum">{fmtNumber(savedCutQty)}</strong> pcs,
                which no longer matches the <strong className="tnum">{fmtNumber(cutOrderQty)}</strong> pcs
                calculated above. {pctDirty && 'Save the allowance, then regenerate'}
                {!pctDirty && 'Regenerate'} to bring them back in line.
              </p>
            ) : null}
          </div>
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
                        <ColourSwatch name={c.name} hex={swatch} size="md" />
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

    </div>
  );
}
