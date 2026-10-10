/**
 * One material: its position, who has it reserved, and every movement that ever
 * touched it.
 *
 * The movement list is the point of the page. A balance is an assertion; the
 * ledger underneath it is the evidence, and it is what someone reads when the
 * figure on the shelf disagrees with the figure on the screen.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, PackagePlus, Scale, Trash2 } from 'lucide-react';
import { MATERIAL_TYPE_LABEL, MOVEMENT_TYPE_LABEL, fmtNumber, fmtDate, type MaterialType, type MovementType } from '@opsflow/shared';
import { api, type ReservationRow } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Card, CardHeader, ConfirmDialog, EmptyState, ErrorNote, Spinner, clsx, useToast } from '../../components/ui';
import { StockStatusChip, StockPositionPanel, MovementDirection } from './parts';
import { ReceiveModal, AdjustModal } from './MaterialsPage';

export function MaterialDetailPage() {
  const { id = '' } = useParams();
  const { can, isSuperAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [receiving, setReceiving] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Super administrators only, matching the endpoint. A material with any stock
  // history is refused there with the reason, and that reason is shown here.
  const remove = useMutation({
    mutationFn: () => api.inventory.deleteMaterial(id),
    onSuccess: () => {
      setDeleting(false);
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      toast.success('Material deleted.');
      navigate('/inventory/materials');
    },
    onError: (e) => { setDeleting(false); toast.error(e); },
  });

  const { data: material, isLoading, error, refetch } = useQuery({
    queryKey: ['inventory', 'material', id],
    queryFn: () => api.inventory.material(id),
  });

  const { data: movements } = useQuery({
    queryKey: ['inventory', 'material', id, 'movements'],
    queryFn: () => api.inventory.materialMovements(id, 200),
  });

  if (isLoading) return <Spinner label="Loading material…" />;
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;
  if (!material) return null;

  const refresh = () => qc.invalidateQueries({ queryKey: ['inventory'] });

  const specs: Array<[string, string | null]> = [
    ['Code', material.code],
    ['Type', MATERIAL_TYPE_LABEL[material.type as MaterialType] ?? material.type],
    ['Colour', material.colorName],
    ['Composition', material.composition],
    ['GSM', material.gsm == null ? null : String(material.gsm)],
    ['Width', material.widthCm == null ? null : `${material.widthCm} cm`],
    ['Size', material.sizeLabel],
    ['Supplier', material.supplierName],
    ['Unit cost', material.unitCostUsd == null ? null : `$${material.unitCostUsd.toFixed(4)}`],
    ['Minimum stock', material.minimumQty == null ? null : `${fmtNumber(material.minimumQty, { places: 0 })} ${material.unit}`],
  ];

  return (
    <div className="space-y-4 p-5">
      <div>
        <Link to="/inventory/materials" className="mb-2 inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-800">
          <ChevronLeft className="h-3.5 w-3.5" /> Materials
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-ink-900">{material.name}</h1>
              <StockStatusChip status={material.position.status} />
              {!material.active && <span className="chip bg-ink-100 text-ink-600 ring-ink-200">Inactive</span>}
            </div>
            {material.notes && <p className="mt-1 max-w-2xl text-sm text-ink-600">{material.notes}</p>}
          </div>
          {can('material:issue') && (
            <div className="flex gap-2">
              <button className="btn-secondary btn-sm" onClick={() => setReceiving(true)}>
                <PackagePlus className="h-3.5 w-3.5" /> Receive
              </button>
              <button className="btn-secondary btn-sm" onClick={() => setAdjusting(true)}>
                <Scale className="h-3.5 w-3.5" /> Adjust
              </button>
            </div>
          )}
          {isSuperAdmin && (
            <button className="btn-ghost btn-sm text-red-600 hover:bg-red-50" onClick={() => setDeleting(true)}>
              <Trash2 className="h-3.5 w-3.5" /> Delete material
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleting}
        onCancel={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
        title={`Delete ${material.name}?`}
        body="This removes it from the catalogue for good. A material with stock movements, stock on hand, reservations or bill-of-materials lines cannot be deleted; mark it inactive instead."
        confirmLabel="Delete"
        busy={remove.isPending}
        requireTyped={material.name}
      />

      <Card>
        <CardHeader title="Position" subtitle="Available is what another order could actually take" />
        <div className="p-4">
          <StockPositionPanel position={material.position} unit={material.unit} />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Specification" />
          <dl className="divide-y divide-ink-100">
            {specs.filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3 px-4 py-2">
                <dt className="text-xs text-ink-500">{k}</dt>
                <dd className="text-sm text-ink-800">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Reserved by"
            subtitle={
              material.reservations.length === 0
                ? 'Nothing is committed to an order'
                : `${material.reservations.length} order${material.reservations.length === 1 ? '' : 's'} hold${material.reservations.length === 1 ? 's' : ''} stock`
            }
          />
          {material.reservations.length === 0 ? (
            <EmptyState title="No reservations" detail="All of this material is free to commit." />
          ) : (
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Order</th>
                  <th className="th text-right">Reserved</th>
                  <th className="th text-right">Issued</th>
                  <th className="th text-right">Still held</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {material.reservations.map((r) => (
                  <tr key={r.id}>
                    <td className="td">
                      <Link to={`/orders/${r.orderId}?tab=materials`} className="font-mono text-xs font-semibold text-accent-700 hover:underline">
                        {r.poNumber}
                      </Link>
                      <span className="ml-2 text-xs text-ink-600">{r.orderName}</span>
                    </td>
                    <td className="td tnum text-right">{fmtNumber(r.qty, { places: 0 })}</td>
                    <td className="td tnum text-right text-ink-500">{fmtNumber(r.consumedQty, { places: 0 })}</td>
                    <td className="td tnum text-right font-semibold">{fmtNumber(r.outstandingQty, { places: 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Movement history"
          subtitle="Append-only. A correction is another movement, never an edit."
        />
        {!movements || movements.data.length === 0 ? (
          <EmptyState title="No movements yet" detail="Receipts, issues and returns appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">When</th>
                  <th className="th">Movement</th>
                  <th className="th text-right">Change</th>
                  <th className="th text-right">Balance</th>
                  <th className="th">Order</th>
                  <th className="th">Reason</th>
                  <th className="th">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {movements.data.map((m) => (
                  <tr key={m.id} className="hover:bg-ink-50/60">
                    <td className="td whitespace-nowrap text-xs text-ink-500">{fmtDate(m.occurredAt)}</td>
                    <td className="td text-xs">
                      {MOVEMENT_TYPE_LABEL[m.type as MovementType] ?? m.type}
                      {m.batchLot && <span className="ml-1.5 text-2xs text-ink-400">lot {m.batchLot}</span>}
                    </td>
                    <td className="td text-right">
                      <MovementDirection type={m.type} signedQty={m.signedQty} unit={m.unit} />
                    </td>
                    <td className="td tnum text-right text-ink-700">{fmtNumber(m.balanceAfter, { places: 0 })}</td>
                    <td className="td">
                      {m.orderId
                        ? <Link to={`/orders/${m.orderId}`} className="font-mono text-2xs text-accent-700 hover:underline">{m.orderPoNumber}</Link>
                        : <span className="text-2xs text-ink-300">—</span>}
                    </td>
                    <td className="td max-w-xs truncate text-xs text-ink-600">{m.reason ?? '—'}</td>
                    <td className="td text-xs text-ink-500">{m.actorName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ReceiveModal
        material={receiving ? material : null}
        onClose={() => setReceiving(false)}
        onDone={() => { setReceiving(false); refresh(); toast.success('Stock received.'); }}
      />
      <AdjustModal
        material={adjusting ? material : null}
        onClose={() => setAdjusting(false)}
        onDone={() => { setAdjusting(false); refresh(); toast.success('Stock adjusted.'); }}
      />
    </div>
  );
}

/** Every reservation in the factory, so a coordinator can see who holds what. */
export function ReservationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const pending = useQuery({ queryKey: ['inventory', 'reservations', 'PENDING'], queryFn: () => api.inventory.reservations({ status: 'PENDING' }) });
  const active = useQuery({ queryKey: ['inventory', 'reservations', 'ACTIVE'], queryFn: () => api.inventory.reservations({}) });
  const rejected = useQuery({ queryKey: ['inventory', 'reservations', 'REJECTED'], queryFn: () => api.inventory.reservations({ status: 'REJECTED' }) });
  const [rejecting, setRejecting] = useState<ReservationRow | null>(null);
  const [note, setNote] = useState('');

  const done = (message: string) => { void qc.invalidateQueries({ queryKey: ['inventory'] }); void qc.invalidateQueries({ queryKey: ['order'] }); toast.success(message); };
  const accept = useMutation({
    mutationFn: (r: ReservationRow) => api.inventory.acceptReservation(r.id),
    onSuccess: (_d, r) => done(`Accepted: ${fmtNumber(r.qty, { places: 0 })} ${r.unit} of ${r.materialName} reserved for ${r.poNumber}.`),
    onError: (e) => toast.error(e),
  });
  const reject = useMutation({
    mutationFn: ({ r, reason }: { r: ReservationRow; reason: string }) => api.inventory.rejectReservation(r.id, reason || undefined),
    onSuccess: (_d, { r }) => { setRejecting(null); setNote(''); done(`Rejected the request for ${r.materialName} on ${r.poNumber}.`); },
    onError: (e) => toast.error(e),
  });
  const withdraw = useMutation({
    mutationFn: (r: ReservationRow) => api.inventory.releaseReservation(r.id, 'Request withdrawn'),
    onSuccess: () => done('Request withdrawn.'),
    onError: (e) => toast.error(e),
  });

  if (pending.isLoading || active.isLoading) return <Spinner label="Loading reservations…" />;
  if (pending.error || active.error) return <div className="p-6"><ErrorNote error={pending.error ?? active.error} onRetry={() => { void pending.refetch(); void active.refetch(); }} /></div>;

  const waiting = pending.data?.data ?? [];
  const rows = active.data?.data ?? [];
  const recentRejected = (rejected.data?.data ?? []).slice(0, 10);
  const canDecide = pending.data?.canDecide ?? false;

  const materialCell = (r: ReservationRow) => (
    <td className="td">
      <Link to={`/inventory/materials/${r.materialId}`} className="font-medium text-ink-900 hover:text-accent-700">{r.materialName}</Link>
      {r.materialCode && <span className="ml-1.5 text-2xs text-ink-400">{r.materialCode}</span>}
    </td>
  );
  const orderCell = (r: ReservationRow) => (
    <td className="td">
      <Link to={`/orders/${r.orderId}?tab=materials`} className="font-mono text-xs font-semibold text-accent-700 hover:underline">{r.poNumber}</Link>
      <span className="ml-2 truncate text-xs text-ink-600">{r.orderName}</span>
    </td>
  );

  return (
    <div className="space-y-4 p-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Reservations</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Stock committed to an order but still on the shelf. Anyone can ask for a reservation; it holds
          stock only once a super administrator or one of the named deciders accepts it.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Waiting for a decision"
          subtitle={waiting.length === 0 ? 'No requests waiting' : `${waiting.length} request${waiting.length === 1 ? '' : 's'}${canDecide ? ' for you to accept or reject' : ''}. Requests hold no stock until accepted.`}
        />
        {waiting.length === 0 ? (
          <EmptyState title="Nothing is waiting" detail="Ask for a reservation from an order's Materials tab." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Material</th><th className="th">Order</th><th className="th">Due</th>
                  <th className="th text-right">Requested</th><th className="th">Asked by</th><th className="th">When</th><th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {waiting.map((r) => (
                  <tr key={r.id} className="hover:bg-ink-50/60">
                    {materialCell(r)}
                    {orderCell(r)}
                    <td className="td text-xs text-ink-500">{r.requiredDeliveryDate ? fmtDate(r.requiredDeliveryDate) : '—'}</td>
                    <td className="td tnum text-right font-semibold">{fmtNumber(r.qty, { places: 0 })} <span className="text-2xs font-normal text-ink-400">{r.unit}</span></td>
                    <td className="td text-xs text-ink-600">{r.reservedByName ?? '—'}</td>
                    <td className="td text-xs text-ink-500">{fmtDate(r.createdAt)}</td>
                    <td className="td text-right">
                      <div className="flex justify-end gap-1">
                        {canDecide && (
                          <>
                            <button className="btn-primary btn-sm" disabled={accept.isPending} onClick={() => accept.mutate(r)}>Accept</button>
                            <button className="btn-secondary btn-sm text-red-700" onClick={() => { setNote(''); setRejecting(r); }}>Reject</button>
                          </>
                        )}
                        {r.reservedById === user?.id && (
                          <button className="btn-ghost btn-sm" disabled={withdraw.isPending} onClick={() => withdraw.mutate(r)}>Withdraw</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Active reservations" subtitle={`${rows.length} across the factory`} />
        {rows.length === 0 ? (
          <EmptyState title="Nothing is reserved" detail="Accepted requests appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Material</th><th className="th">Order</th><th className="th">Due</th>
                  <th className="th text-right">Reserved</th><th className="th text-right">Issued</th><th className="th text-right">Still held</th>
                  <th className="th">Asked by</th><th className="th">Accepted by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-ink-50/60">
                    {materialCell(r)}
                    {orderCell(r)}
                    <td className="td text-xs text-ink-500">{r.requiredDeliveryDate ? fmtDate(r.requiredDeliveryDate) : '—'}</td>
                    <td className="td tnum text-right">{fmtNumber(r.qty, { places: 0 })} <span className="text-2xs text-ink-400">{r.unit}</span></td>
                    <td className="td tnum text-right text-ink-500">{fmtNumber(r.consumedQty, { places: 0 })}</td>
                    <td className="td tnum text-right font-semibold">{fmtNumber(r.outstandingQty, { places: 0 })}</td>
                    <td className="td text-xs text-ink-500">{r.reservedByName ?? '—'}</td>
                    <td className="td text-xs text-ink-500">{r.decidedByName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {recentRejected.length > 0 && (
        <Card>
          <CardHeader title="Recently rejected" subtitle="The last ten requests turned down" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr><th className="th">Material</th><th className="th">Order</th><th className="th text-right">Requested</th><th className="th">Asked by</th><th className="th">Rejected by</th><th className="th">Reason</th></tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {recentRejected.map((r) => (
                  <tr key={r.id}>
                    {materialCell(r)}
                    {orderCell(r)}
                    <td className="td tnum text-right">{fmtNumber(r.qty, { places: 0 })} <span className="text-2xs text-ink-400">{r.unit}</span></td>
                    <td className="td text-xs text-ink-500">{r.reservedByName ?? '—'}</td>
                    <td className="td text-xs text-ink-500">{r.decidedByName ?? '—'}{r.decidedAt ? ` · ${fmtDate(r.decidedAt)}` : ''}</td>
                    <td className="td whitespace-normal text-xs text-ink-600">{r.decisionNote || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={!!rejecting}
        onCancel={() => setRejecting(null)}
        onConfirm={() => rejecting && reject.mutate({ r: rejecting, reason: note.trim() })}
        title="Reject this request?"
        body={rejecting ? `${fmtNumber(rejecting.qty, { places: 0 })} ${rejecting.unit} of ${rejecting.materialName} for ${rejecting.poNumber}, asked by ${rejecting.reservedByName ?? 'someone'}.` : undefined}
        confirmLabel="Reject"
        busy={reject.isPending}
      >
        <label className="mt-3 block text-xs text-ink-600">
          Reason (optional, shown to the person who asked)
          <textarea className="input mt-1" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      </ConfirmDialog>
    </div>
  );
}

/** The factory-wide movement feed — every gram in or out, newest first. */
export function MovementsPage() {
  const [type, setType] = useState('');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['inventory', 'movements', type],
    queryFn: () => api.inventory.movements({ type: type || undefined, limit: 200 }),
  });
  const { data: meta } = useQuery({ queryKey: ['inventory', 'meta'], queryFn: api.inventory.meta });

  if (isLoading) return <Spinner label="Loading movements…" />;
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;

  const rows = data?.data ?? [];

  return (
    <div className="space-y-4 p-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Stock movements</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Every receipt, issue, return, adjustment and write-off, across all materials.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Recent movements"
          subtitle={`${rows.length} shown, newest first`}
          action={
            <select className="input w-48" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All movement types</option>
              {(meta?.movementTypes ?? []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          }
        />
        {rows.length === 0 ? (
          <EmptyState title="No movements" detail="Stock activity will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">When</th>
                  <th className="th">Material</th>
                  <th className="th">Movement</th>
                  <th className="th text-right">Change</th>
                  <th className="th text-right">Balance</th>
                  <th className="th">Order</th>
                  <th className="th">Reason</th>
                  <th className="th">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((m) => (
                  <tr key={m.id} className="hover:bg-ink-50/60">
                    <td className="td whitespace-nowrap text-xs text-ink-500">{fmtDate(m.occurredAt)}</td>
                    <td className="td">
                      <Link to={`/inventory/materials/${m.materialId}`} className="text-sm text-ink-800 hover:text-accent-700">
                        {m.materialName}
                      </Link>
                    </td>
                    <td className="td text-xs">{MOVEMENT_TYPE_LABEL[m.type as MovementType] ?? m.type}</td>
                    <td className="td text-right"><MovementDirection type={m.type} signedQty={m.signedQty} unit={m.unit} /></td>
                    <td className="td tnum text-right text-ink-700">{fmtNumber(m.balanceAfter, { places: 0 })}</td>
                    <td className="td">
                      {m.orderId
                        ? <Link to={`/orders/${m.orderId}`} className="font-mono text-2xs text-accent-700 hover:underline">{m.orderPoNumber}</Link>
                        : <span className="text-2xs text-ink-300">—</span>}
                    </td>
                    <td className="td max-w-xs truncate text-xs text-ink-600">{m.reason ?? '—'}</td>
                    <td className="td text-xs text-ink-500">{m.actorName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export { clsx };
