/**
 * Step 14 — Stock (finished goods already in the building).
 *
 * The workbook's Stock sheet is not a warehouse report. It is the deduction
 * that shrinks the cut order: whatever is already made does not need cutting
 * again. `ROUNDUP((order − stock) × 1.05)` is the formula in the Cut Order
 * sheet, and `stock` is what is entered here.
 *
 * The step never completes itself, because "we checked and there is none" and
 * "nobody has looked yet" are different answers that look identical in an empty
 * table. Recording a zero row is a real answer; leaving the table empty is not.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { fmtDate, type OrderDetailDto } from '@opsflow/shared';
import { api, type StockRecordDto } from '../../lib/api';
import { Card, Modal, Field, Spinner, EmptyState, ConfirmDialog, Num, useToast } from '../../components/ui';

interface Draft {
  colorName: string;
  sizeName: string;
  availableQty: string;
  location: string;
  notes: string;
}

const EMPTY: Draft = { colorName: '', sizeName: '', availableQty: '', location: '', notes: '' };

export function StockTab({ order }: { order: OrderDetailDto }) {
  const orderId = order.id;
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StockRecordDto | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['order-stock', orderId],
    queryFn: () => api.steps.stock(orderId),
  });

  const { data: axes } = useQuery({
    queryKey: ['order-matrix', orderId],
    queryFn: () => api.orders.matrix(orderId),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['order-stock', orderId] });
    // Stock changes the cut order, so the whole derived order changes with it.
    qc.invalidateQueries({ queryKey: ['order', orderId] });
    qc.invalidateQueries({ queryKey: ['order-steps', orderId] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) => api.steps.recordStock(orderId, {
      colorName: d.colorName.trim(),
      sizeName: d.sizeName.trim(),
      availableQty: Number(d.availableQty),
      location: d.location.trim() || undefined,
      notes: d.notes.trim() || undefined,
    }),
    onSuccess: () => { refresh(); setDraft(null); toast.success('Finished stock recorded'); },
    onError: (e) => toast.error(e),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.steps.removeStock(orderId, id),
    onSuccess: () => { refresh(); setConfirmDelete(null); toast.success('Stock row removed'); },
    onError: (e) => toast.error(e),
  });

  const rows = data?.data ?? [];
  const total = data?.totalAvailable ?? 0;
  // The colour and size axes come from the matrix endpoint — the same two
  // lists the Quantity tab uses — so the suggestions here cannot drift from
  // the names the order is actually recorded against.
  const colorNames = axes?.colors.map((c) => c.name) ?? [];
  const sizeNames = axes?.sizes.map((z) => z.name) ?? [];
  const qty = draft ? Number(draft.availableQty) : NaN;
  const valid = draft != null
    && draft.colorName.trim().length > 0
    && draft.sizeName.trim().length > 0
    && Number.isInteger(qty) && qty >= 0;

  if (isLoading) return <Spinner label="Loading finished stock…" />;

  return (
    <div className="space-y-4 p-5">
      <Card>
        <div className="card-header">
          <h3 className="card-title">Finished pieces already in stock</h3>
          <button className="btn-primary btn-sm" onClick={() => setDraft(EMPTY)}>
            <Plus className="h-3.5 w-3.5" /> Record stock
          </button>
        </div>

        <div className="grid grid-cols-1 gap-px border-b border-ink-200 bg-ink-200 sm:grid-cols-3">
          <Tile label="Ordered" value={order.stockDeduction.customerOrderQty} />
          <Tile label="Already in stock" value={total} />
          <Tile
            label="Still to cut"
            value={order.stockDeduction.cutQtyWithAllowance}
            hint="Includes the cut allowance on top of what stock does not cover"
          />
        </div>

        {rows.length === 0 ? (
          <EmptyState
            title="Nobody has checked stock for this order yet"
            detail={
              'If there is none, record a zero row or mark this step “Not required” above. ' +
              'An empty table cannot tell the difference between “none” and “not looked”.'
            }
          />
        ) : (
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Colour</th>
                <th className="th">Size</th>
                <th className="th text-right">Available</th>
                <th className="th">Location</th>
                <th className="th">Notes</th>
                <th className="th">Recorded</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="td font-medium text-ink-800">{r.colorName}</td>
                  <td className="td">{r.sizeName}</td>
                  <td className="td tnum text-right font-semibold">{r.availableQty.toLocaleString()}</td>
                  <td className="td text-xs">{r.location || '—'}</td>
                  <td className="td text-xs text-ink-600">{r.notes || '—'}</td>
                  <td className="td text-xs">{fmtDate(r.recordedAt)}</td>
                  <td className="td text-right">
                    <button
                      className="btn-ghost btn-sm text-red-600 hover:bg-red-50"
                      onClick={() => setConfirmDelete(r)}
                      aria-label={`Remove ${r.colorName} ${r.sizeName}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="border-t border-ink-100 bg-ink-50 px-4 py-2 text-2xs text-ink-500">
          Finished stock reduces the cut order — the workbook's own
          <span className="font-mono"> ROUNDUP((order − stock) × 1.05)</span>. Recording it here
          changes the cut quantities on the Quantity tab; it is not a separate note.
        </p>
      </Card>

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title="Record finished stock"
        subtitle="One row per colour and size, as the workbook's Stock sheet has it."
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setDraft(null)}>Cancel</button>
            <button
              className="btn-primary btn-sm"
              disabled={!valid || save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              Save
            </button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Colour">
                <input
                  className="input"
                  list="stock-colors"
                  value={draft.colorName}
                  onChange={(e) => setDraft({ ...draft, colorName: e.target.value })}
                  autoFocus
                />
                <datalist id="stock-colors">
                  {colorNames.map((n) => <option key={n} value={n} />)}
                </datalist>
              </Field>
              <Field label="Size">
                <input
                  className="input"
                  list="stock-sizes"
                  value={draft.sizeName}
                  onChange={(e) => setDraft({ ...draft, sizeName: e.target.value })}
                />
                <datalist id="stock-sizes">
                  {sizeNames.map((n) => <option key={n} value={n} />)}
                </datalist>
              </Field>
            </div>

            <Field
              label="Pieces available"
              hint="Zero is a valid answer, and a more useful one than no row at all."
            >
              <input
                className="input tnum"
                type="number"
                min={0}
                step={1}
                value={draft.availableQty}
                onChange={(e) => setDraft({ ...draft, availableQty: e.target.value })}
              />
            </Field>

            <Field label="Where is it?" hint="Optional. Rack, shelf, or the store's own reference.">
              <input
                className="input"
                value={draft.location}
                onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              />
            </Field>

            <Field label="Notes" hint="Optional.">
              <input
                className="input"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </Field>

            <p className="rounded border border-ink-200 bg-ink-50 px-3 py-2 text-2xs text-ink-600">
              Recording a colour and size that already has a row replaces that row rather than
              adding a second one.
            </p>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete.id)}
        busy={remove.isPending}
        title="Remove this stock row?"
        confirmLabel="Remove"
        body={
          <>
            The cut order will go back up by {confirmDelete?.availableQty.toLocaleString()} pieces
            for {confirmDelete?.colorName} / {confirmDelete?.sizeName}.
          </>
        }
      />
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className="tnum mt-0.5 text-xl font-semibold text-ink-900">
        <Num value={value} />
      </p>
      {hint && <p className="mt-0.5 text-2xs text-ink-500">{hint}</p>}
    </div>
  );
}
