/** Packing lists, cartons and shipments. */

import { PackingSizeGrid } from '../../components/PackingSizeGrid';
import { CartonSizes } from '../../components/CartonSizes';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, PackageCheck, Truck, Trash2, Table2 } from 'lucide-react';
import { fmtDate, fmtNumber, type OrderDetailDto } from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { localToday } from '../../lib/local-today';
import {
  Card, CardHeader, StatTile, Num, Modal, Field, Spinner, ErrorNote, EmptyState, clsx, useToast,
} from '../../components/ui';
import { AttachmentsPanel } from '../../components/Attachments';
import { PackingFileLayoutModal } from '../../components/PackingFileLayout';
import { ComboSelect } from '../../components/ComboSelect';

interface PackingList {
  id: string; reference: string | null; approved: boolean; approvedAt: string | null;
  approvedByName: string | null; notes: string | null;
  cartons: Array<{
    id: string; cartonNumber: string; cartonSize: string | null; colorName: string | null;
    lines?: Array<{ id: string; orderSizeId: string | null; sizeName: string | null; qty: number }>;
    sizeName: string | null; qty: number; grossWeightKg: number | null; netWeightKg: number | null;
    orderSizeId?: string | null;
  }>;
  totals: { cartonCount: number; totalQty: number; grossWeightKg: number; netWeightKg: number };
}

interface Shipment {
  id: string; method: string | null; status: string; qty: number;
  promisedShippingDate: string | null; requiredDeliveryDate: string | null;
  actualShippingDate: string | null; deliveredDate?: string | null;
  trackingNumber: string | null; carrier: string | null;
  overrideApproved: boolean; overrideReason: string | null;
}

const SHIP_STATUSES = ['NOT_READY', 'READY', 'BOOKED', 'SHIPPED', 'DELIVERED'] as const;

const SHIP_TONE: Record<string, string> = {
  NOT_READY: 'bg-ink-100 text-ink-600 ring-ink-500/20',
  READY: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  BOOKED: 'bg-accent-50 text-accent-700 ring-accent-600/20',
  SHIPPED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  DELIVERED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
};

/** A packing file the server can read a layout from. */
const readableLayout = (fileName: string): boolean => /\.(xlsx|xlsm|csv|txt|pdf)$/i.test(fileName);

export function PackingTab({ order }: { order: OrderDetailDto; focus?: "packing" | "shipping" }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [addingCarton, setAddingCarton] = useState<string | null>(null);
  const [addingSizes, setAddingSizes] = useState<string | null>(null);
  /** The carton waiting on Remove / Keep. One at a time, like the records table. */
  const [removingCarton, setRemovingCarton] = useState<string | null>(null);
  const toast = useToast();
  const failed = (fallback: string) => (e: unknown) => toast.error(e instanceof ApiError ? e.message : fallback);
  const [editingCarton, setEditingCarton] = useState<{ id: string; number: string; lines: Array<{ orderSizeId: string | null; qty: number }> } | null>(null);
  const [shipping, setShipping] = useState(false);
  /** The packing file whose layout is open. */
  const [layoutOf, setLayoutOf] = useState<{ id: string; fileName: string } | null>(null);

  const lists = useQuery({ queryKey: ['packing', order.id], queryFn: () => api.packing.lists(order.id) });
  const shipments = useQuery({ queryKey: ['shipments', order.id], queryFn: () => api.packing.shipments(order.id) });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['packing', order.id] });
    void qc.invalidateQueries({ queryKey: ['shipments', order.id] });
    void qc.invalidateQueries({ queryKey: ['order', order.id] });
    // Cartons move the PACKED ledger, which the quantity grids read.
    void qc.invalidateQueries({ queryKey: ['matrix', order.id] });
  };

  const [shipmentError, setShipmentError] = useState<string | null>(null);
  const updateShipment = useMutation({
    mutationFn: (v: { id: string; status: string }) => api.packing.updateShipment(v.id, { status: v.status }),
    onSuccess: () => { setShipmentError(null); invalidate(); },
    onError: (e) => setShipmentError(e instanceof ApiError ? e.message : 'Could not update the shipment.'),
  });

  const createList = useMutation({ mutationFn: () => api.packing.createList(order.id), onSuccess: invalidate });
  // A refusal — already approved, nothing to approve — is said, not swallowed;
  // either way the list is reloaded, since a 409 means it changed underneath.
  const approve = useMutation({
    mutationFn: (id: string) => api.packing.approve(id),
    onSuccess: () => { toast.success('Packing list approved'); invalidate(); },
    onError: (e) => { failed('Could not approve the packing list.')(e); invalidate(); },
  });
  const reopen = useMutation({
    mutationFn: (id: string) => api.packing.reopen(id),
    onSuccess: () => { toast.success('Packing list reopened for changes'); invalidate(); },
    onError: failed('Could not reopen the packing list.'),
  });
  const removeCarton = useMutation({
    mutationFn: (id: string) => api.packing.removeCarton(id),
    onSuccess: () => { setRemovingCarton(null); toast.success('Carton removed'); invalidate(); },
    onError: failed('Could not remove the carton.'),
  });

  if (lists.isLoading || shipments.isLoading) return <Spinner />;

  const packingLists = (lists.data?.data ?? []) as unknown as PackingList[];
  const shipmentList = (shipments.data?.data ?? []) as unknown as Shipment[];
  const packedQty = order.funnel.find((f) => f.ledger === 'PACKED')?.qty ?? 0;
  const shippedQty = order.funnel.find((f) => f.ledger === 'SHIPPED')?.qty ?? 0;

  return (
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* The same produced figure the server checks shipments against: the
            in-line ledger or sewing, whichever is further along. */}
        <StatTile label="Produced" value={fmtNumber(order.producedQty)} />
        <StatTile label="Packed" value={fmtNumber(packedQty)} tone={packedQty > 0 ? 'accent' : 'neutral'} />
        <StatTile
          label="Cartons"
          value={packingLists.reduce((a, l) => a + l.totals.cartonCount, 0)}
        />
        <StatTile label="Shipped" value={fmtNumber(shippedQty)} tone={shippedQty > 0 ? 'emerald' : 'neutral'} />
      </div>

      {/* Packing lists */}
      <Card>
        <CardHeader
          title="Packing lists"
          subtitle="The coordinator reviews and approves before the shipment can be booked"
          action={
            can('packing:write') && (
              <button onClick={() => createList.mutate()} className="btn-secondary btn-sm">
                <Plus className="h-3.5 w-3.5" /> New list
              </button>
            )
          }
        />
        {packingLists.length === 0 ? (
          <EmptyState title="No packing list yet" detail="Packing builds the list; the coordinator reviews it." />
        ) : (
          packingLists.map((l) => (
            <div key={l.id} className="border-b border-ink-100 last:border-0">
              <div className="flex flex-wrap items-center justify-between gap-3 bg-ink-50 px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-sm font-medium text-ink-900">
                    {l.reference || `Packing list ${l.id.slice(-6)}`}
                  </span>
                  {l.approved ? (
                    <span className="chip bg-emerald-50 text-emerald-700 ring-emerald-600/20">
                      <PackageCheck className="h-3 w-3" />
                      Approved{l.approvedByName ? ` by ${l.approvedByName}` : ''}
                    </span>
                  ) : (
                    <span className="chip bg-amber-50 text-amber-800 ring-amber-600/20">Awaiting review</span>
                  )}
                </div>
                <div className="flex items-center gap-4 text-xs text-ink-600">
                  <span><strong className="tnum">{l.totals.cartonCount}</strong> cartons</span>
                  <span><strong className="tnum">{fmtNumber(l.totals.totalQty)}</strong> pcs</span>
                  <span>GW <strong className="tnum">{l.totals.grossWeightKg.toFixed(1)}</strong> kg</span>
                  <span>NW <strong className="tnum">{l.totals.netWeightKg.toFixed(1)}</strong> kg</span>
                  {can('packing:write') && !l.approved && (
                    <>
                      <button onClick={() => setAddingCarton(l.id)} className="btn-secondary btn-sm">
                        <Plus className="h-3 w-3" /> Carton
                      </button>
                      {/* The whole size run at once, rather than one dialog per size. */}
                      <button onClick={() => setAddingSizes(l.id)} className="btn-secondary btn-sm">
                        <Plus className="h-3 w-3" /> Sizes
                      </button>
                    </>
                  )}
                  {can('packing:approve') && !l.approved && l.cartons.length > 0 && (
                    <button
                      onClick={() => approve.mutate(l.id)}
                      disabled={approve.isPending}
                      className="btn-primary btn-sm"
                    >
                      {approve.isPending && approve.variables === l.id ? 'Approving…' : 'Approve'}
                    </button>
                  )}
                  {/* Approval locks the cartons; reopening is how a wrong one
                      is put right. Refused while an issued invoice uses it. */}
                  {can('packing:approve') && l.approved && (
                    <button
                      onClick={() => reopen.mutate(l.id)}
                      disabled={reopen.isPending}
                      className="btn-secondary btn-sm"
                      title="Take the list back to review so its cartons can be changed"
                    >
                      Reopen
                    </button>
                  )}
                </div>
              </div>

              {l.cartons.length > 0 && (
                <table className="w-full">
                  <thead className="border-b border-ink-200">
                    <tr>
                      <th className="th">C/No</th>
                      <th className="th">Size box</th>
                      <th className="th">Colour</th>
                      <th className="th">Size</th>
                      <th className="th text-right">Qty</th>
                      <th className="th text-right">GW (kg)</th>
                      <th className="th text-right">NW (kg)</th>
                      <th className="th w-32" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {l.cartons.map((c) => (
                      <tr key={c.id}>
                        <td className="td font-mono text-xs">{c.cartonNumber}</td>
                        <td className="td text-xs">{c.cartonSize || '—'}</td>
                        <td className="td text-xs">{c.colorName || '—'}</td>
                        <td className="td text-xs">
                          {/* A mixed carton lists its sizes; a single-size one
                              still reads exactly as it did. */}
                          {c.lines && c.lines.length > 0
                            ? c.lines.map((ln) => `${ln.sizeName ?? '?'} ×${ln.qty}`).join(', ')
                            : c.sizeName || '—'}
                        </td>
                        <td className="td text-right"><Num value={c.qty} /></td>
                        <td className="td text-right"><Num value={c.grossWeightKg} places={2} fallback="—" /></td>
                        <td className="td text-right"><Num value={c.netWeightKg} places={2} fallback="—" /></td>
                        <td className="td whitespace-nowrap text-right">
                          {can('packing:write') && !l.approved && removingCarton === c.id && (
                            <>
                              <button
                                className="btn-sm btn-danger"
                                onClick={() => removeCarton.mutate(c.id)}
                                disabled={removeCarton.isPending}
                              >
                                Remove
                              </button>{' '}
                              <button className="btn-secondary btn-sm" onClick={() => setRemovingCarton(null)}>Keep</button>
                            </>
                          )}
                          {can('packing:write') && !l.approved && removingCarton !== c.id && (
                            <>
                              <button
                                className="btn-ghost btn-sm"
                                title="Set the sizes inside this carton"
                                onClick={() => setEditingCarton({
                                  id: c.id,
                                  number: c.cartonNumber,
                                  // A single-size carton has no lines; it opens on
                                  // its own size and quantity, not the first size
                                  // at zero, which saved would have unpacked it.
                                  lines: c.lines && c.lines.length > 0
                                    ? c.lines.map((ln) => ({ orderSizeId: ln.orderSizeId, qty: ln.qty }))
                                    : c.orderSizeId ? [{ orderSizeId: c.orderSizeId, qty: c.qty }] : [],
                                })}
                              >
                                Sizes
                              </button>
                              <button
                                className="btn-ghost btn-sm text-ink-400 hover:text-red-600"
                                title="Remove this carton and take its pieces off the packed count"
                                onClick={() => setRemovingCarton(c.id)}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))
        )}
      </Card>

      {/* Shipping */}
      <Card>
        <CardHeader
          title="Shipping"
          subtitle={`${order.shippingMethod ?? 'Method not set'} · promised ${fmtDate(order.promisedShippingDate)} · required ${fmtDate(order.requiredDeliveryDate)}`}
          action={
            can('shipment:write') && (
              <button onClick={() => setShipping(true)} className="btn-primary btn-sm">
                <Truck className="h-3.5 w-3.5" /> Record shipment
              </button>
            )
          }
        />
        {shipmentError && <div className="px-4 pt-3"><ErrorNote error={new Error(shipmentError)} /></div>}
        {shipmentList.length === 0 ? (
          <EmptyState title="Nothing shipped yet" />
        ) : (
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Status</th>
                <th className="th">Method</th>
                <th className="th text-right">Qty</th>
                <th className="th">Shipped</th>
                <th className="th">Carrier</th>
                <th className="th">Tracking</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {shipmentList.map((s) => (
                <tr key={s.id}>
                  <td className="td">
                    {/* A consignment moves along in place. Recording a second
                        row to say it arrived counted its pieces twice. */}
                    {can('shipment:write') ? (
                      <ComboSelect
                        aria-label="Shipment status"
                        className={clsx('chip cursor-pointer', SHIP_TONE[s.status])}
                        value={s.status}
                        disabled={updateShipment.isPending}
                        onChange={(e) => updateShipment.mutate({ id: s.id, status: e.target.value })}
                      >
                        {SHIP_STATUSES.map((st) => <option key={st} value={st}>{st.replace(/_/g, ' ')}</option>)}
                      </ComboSelect>
                    ) : (
                      <span className={clsx('chip', SHIP_TONE[s.status])}>{s.status.replace(/_/g, ' ')}</span>
                    )}
                  </td>
                  <td className="td text-xs">{s.method || '—'}</td>
                  <td className="td text-right">
                    <Num value={s.qty} />
                    {s.overrideApproved && (
                      <span className="ml-1.5 chip bg-amber-50 text-amber-800 ring-amber-600/20" title={s.overrideReason ?? ''}>
                        Override
                      </span>
                    )}
                  </td>
                  <td className="td text-xs">{fmtDate(s.actualShippingDate)}</td>
                  <td className="td text-xs">{s.carrier || '—'}</td>
                  <td className="td font-mono text-xs">{s.trackingNumber || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <CartonSizesModal
        carton={editingCarton}
        order={order}
        onClose={() => setEditingCarton(null)}
        onDone={() => { setEditingCarton(null); invalidate(); }}
      />
      <SizeGridModal
        listId={addingSizes}
        existingNumbers={packingLists.find((l) => l.id === addingSizes)?.cartons.map((c) => c.cartonNumber) ?? []}
        order={order}
        onClose={() => setAddingSizes(null)}
        onDone={() => { setAddingSizes(null); invalidate(); }}
      />
      <CartonModal
        listId={addingCarton} order={order}
        onClose={() => setAddingCarton(null)}
        onDone={() => { setAddingCarton(null); invalidate(); }}
      />
      <ShipmentModal
        open={shipping} order={order} producedQty={order.producedQty}
        alreadyShippedQty={shipmentList.reduce((a, s) => a + s.qty, 0)}
        onClose={() => setShipping(false)}
        onDone={() => { setShipping(false); invalidate(); }}
      />
      <AttachmentsPanel
        orderId={order.id}
        documentType="PACKING_LIST"
        stageKey="PACKING"
        title="Packing files"
        detail="Packing lists and carton photographs for this order. A packing list attached as Excel, CSV or PDF is read and its layout shown."
        // A packing list attached here is read straight away and its layout
        // shown; a photograph is just filed.
        onUploaded={(d) => { if (readableLayout(d.fileName)) setLayoutOf({ id: d.id, fileName: d.fileName }); }}
        rowAction={{
          label: 'Layout',
          title: 'Show what this packing file says',
          icon: <Table2 className="mr-1 h-3.5 w-3.5" />,
          applies: (d) => readableLayout(d.fileName),
          run: (d) => setLayoutOf({ id: d.id, fileName: d.fileName }),
        }}
      />
      <PackingFileLayoutModal
        orderId={order.id}
        attachmentId={layoutOf?.id ?? null}
        fileName={layoutOf?.fileName}
        onClose={() => setLayoutOf(null)}
      />
      {/* Shipping paperwork is filed separately: it belongs to the shipment,
          not the packing, and is what a forwarder asks for by name. */}
      <AttachmentsPanel
        orderId={order.id}
        documentType="SHIPPING_DOC"
        stageKey="PACKING"
        title="Shipping documents"
        detail="Bills of lading, airway bills, customs paperwork and certificates."
      />
    </div>
  );
}

function CartonModal({
  listId, order, onClose, onDone,
}: {
  listId: string | null; order: OrderDetailDto; onClose: () => void; onDone: () => void;
}) {
  const { data: matrix } = useQuery({
    queryKey: ['matrix', order.id],
    queryFn: () => api.orders.matrix(order.id),
    enabled: !!listId,
  });

  const [form, setForm] = useState({
    cartonNumber: '', cartonSize: '', orderColorId: '', orderSizeId: '',
    qty: '', grossWeightKg: '', netWeightKg: '',
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.packing.addCarton(listId!, {
        cartonNumber: form.cartonNumber,
        cartonSize: form.cartonSize || undefined,
        orderColorId: form.orderColorId || undefined,
        orderSizeId: form.orderSizeId || undefined,
        qty: Number(form.qty),
        grossWeightKg: form.grossWeightKg ? Number(form.grossWeightKg) : undefined,
        netWeightKg: form.netWeightKg ? Number(form.netWeightKg) : undefined,
      }),
    onSuccess: () => {
      // Keep the box size and weights — cartons come in runs of identical boxes.
      setForm({ ...form, cartonNumber: '', qty: '' });
      setError(null);
      onDone();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not add the carton.'),
  });

  if (!listId) return null;

  return (
    <Modal
      open onClose={onClose} title="Add carton"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Close</button>
          <button onClick={() => save.mutate()} disabled={!form.cartonNumber || !form.qty || save.isPending} className="btn-primary">
            {save.isPending ? 'Adding…' : 'Add carton'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNote error={new Error(error)} />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Carton number">
            <input value={form.cartonNumber} onChange={(e) => setForm({ ...form, cartonNumber: e.target.value })} className="input" autoFocus />
          </Field>
          <Field label="Carton size">
            <input value={form.cartonSize} onChange={(e) => setForm({ ...form, cartonSize: e.target.value })} className="input" />
          </Field>
          <Field label="Colour">
            <ComboSelect value={form.orderColorId} onChange={(e) => setForm({ ...form, orderColorId: e.target.value })} className="input">
              <option value="">Mixed / not specified</option>
              {matrix?.colors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </ComboSelect>
          </Field>
          <Field label="Size">
            <ComboSelect value={form.orderSizeId} onChange={(e) => setForm({ ...form, orderSizeId: e.target.value })} className="input">
              <option value="">Mixed / not specified</option>
              {matrix?.sizes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </ComboSelect>
          </Field>
          <Field label="Quantity">
            <input type="number" min={1} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} className="input" />
          </Field>
          <div />
          <Field label="Gross weight (kg)">
            <input type="number" step="0.01" value={form.grossWeightKg} onChange={(e) => setForm({ ...form, grossWeightKg: e.target.value })} className="input" />
          </Field>
          <Field label="Net weight (kg)">
            <input type="number" step="0.01" value={form.netWeightKg} onChange={(e) => setForm({ ...form, netWeightKg: e.target.value })} className="input" />
          </Field>
        </div>
        <p className="text-2xs text-ink-500">
          Adding a carton with a colour and size also credits the packed ledger, so the funnel,
          the dashboard and this tab never disagree.
        </p>
      </div>
    </Modal>
  );
}

function ShipmentModal({
  open, order, producedQty, alreadyShippedQty, onClose, onDone,
}: {
  open: boolean; order: OrderDetailDto; producedQty: number;
  /** Pieces on consignments already recorded; the limit is on the running total. */
  alreadyShippedQty: number;
  onClose: () => void; onDone: () => void;
}) {
  const { can } = useAuth();
  const [form, setForm] = useState({
    status: 'READY', qty: '', carrier: '', trackingNumber: '',
    actualShippingDate: localToday(),
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const hasLeft = form.status === 'SHIPPED' || form.status === 'DELIVERED';
  const runningTotal = alreadyShippedQty + (Number(form.qty) || 0);
  const exceedsProduced = runningTotal > producedQty && Number(form.qty) > 0;
  const canOverride = can('shipment:override');

  const save = useMutation({
    mutationFn: () =>
      api.packing.createShipment(
        order.id,
        {
          status: form.status, qty: Number(form.qty) || 0,
          method: order.shippingMethod ?? undefined,
          carrier: form.carrier || undefined,
          trackingNumber: form.trackingNumber || undefined,
          // A delivered consignment left too, and has a departure date.
          actualShippingDate: hasLeft ? form.actualShippingDate : undefined,
        },
        exceedsProduced ? reason : undefined,
      ),
    onSuccess: () => { setError(null); onDone(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not record the shipment.'),
  });

  return (
    <Modal
      open={open} onClose={onClose} title="Record shipment"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || (exceedsProduced && (!canOverride || !reason.trim()))}
            className="btn-primary"
          >
            {save.isPending ? 'Recording…' : 'Record'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNote error={new Error(error)} />}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <ComboSelect value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input">
              {SHIP_STATUSES.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </ComboSelect>
          </Field>
          <Field label="Quantity" hint={`${producedQty.toLocaleString()} produced`}>
            <input type="number" min={0} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} className="input" />
          </Field>
          <Field label="Carrier"><input value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} className="input" /></Field>
          <Field label="Tracking / AWB"><input value={form.trackingNumber} onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })} className="input" /></Field>
          {hasLeft && (
            <Field label="Actual shipping date">
              <input type="date" value={form.actualShippingDate} onChange={(e) => setForm({ ...form, actualShippingDate: e.target.value })} className="input" />
            </Field>
          )}
        </div>

        {exceedsProduced && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5">
            <p className="text-sm font-medium text-amber-900">
              Shipping more than has been produced
            </p>
            <p className="mt-0.5 text-xs text-amber-800">
              {runningTotal.toLocaleString()} pieces on shipments
              {alreadyShippedQty > 0 ? ` (${alreadyShippedQty.toLocaleString()} already recorded)` : ''} against{' '}
              {producedQty.toLocaleString()} produced.
              {canOverride
                ? ' As an administrator you can override this, but the reason is recorded in the audit trail.'
                : ' Only an administrator can override this.'}
            </p>
            {canOverride && (
              <input
                value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for the override (required)"
                className="input mt-2"
              />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * The size grid, in the dialog the single-carton form already uses.
 *
 * Colours and sizes come from the order's own matrix, so a packing list can
 * only name a size the order was actually sold in.
 */
function SizeGridModal({
  listId, existingNumbers, order, onClose, onDone,
}: {
  listId: string | null; existingNumbers: readonly string[];
  order: OrderDetailDto; onClose: () => void; onDone: () => void;
}) {
  const { data: matrix } = useQuery({
    queryKey: ['matrix', order.id],
    queryFn: () => api.orders.matrix(order.id),
    enabled: !!listId,
  });

  if (!listId) return null;

  const colors = ((matrix?.colors ?? []) as Array<{ id: string; name: string }>);
  const sizes = ((matrix?.sizes ?? []) as Array<{ id: string; name: string }>);

  return (
    <Modal open onClose={onClose} title="Pack several sizes">
      {colors.length === 0 || sizes.length === 0 ? (
        <p className="text-sm text-ink-600">
          This order has no colours or sizes yet, so there is nothing to pack against.
        </p>
      ) : (
        <PackingSizeGrid
          listId={listId}
          orderId={order.id}
          colors={colors}
          sizes={sizes}
          existingNumbers={existingNumbers}
          onDone={onDone}
        />
      )}
    </Modal>
  );
}

/** The size breakdown of one carton, in the dialog the other packing forms use. */
function CartonSizesModal({
  carton, order, onClose, onDone,
}: {
  carton: { id: string; number: string; lines: Array<{ orderSizeId: string | null; qty: number }> } | null;
  order: OrderDetailDto; onClose: () => void; onDone: () => void;
}) {
  const { data: matrix } = useQuery({
    queryKey: ['matrix', order.id],
    queryFn: () => api.orders.matrix(order.id),
    enabled: !!carton,
  });
  if (!carton) return null;
  const sizes = ((matrix?.sizes ?? []) as Array<{ id: string; name: string }>);
  return (
    <Modal open onClose={onClose} title={`Sizes in carton ${carton.number}`}>
      {sizes.length === 0 ? (
        <p className="text-sm text-ink-600">This order has no sizes yet.</p>
      ) : (
        <CartonSizes
          cartonId={carton.id}
          orderId={order.id}
          sizes={sizes}
          initial={carton.lines}
          onSaved={onDone}
        />
      )}
    </Modal>
  );
}
