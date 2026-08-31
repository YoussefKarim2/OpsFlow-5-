/** Packing lists, cartons and shipments. */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, PackageCheck, Truck } from 'lucide-react';
import { fmtDate, fmtNumber, type OrderDetailDto } from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, StatTile, Num, Modal, Field, Spinner, ErrorNote, EmptyState, clsx,
} from '../../components/ui';

interface PackingList {
  id: string; reference: string | null; approved: boolean; approvedAt: string | null;
  approvedByName: string | null; notes: string | null;
  cartons: Array<{
    id: string; cartonNumber: string; cartonSize: string | null; colorName: string | null;
    sizeName: string | null; qty: number; grossWeightKg: number | null; netWeightKg: number | null;
  }>;
  totals: { cartonCount: number; totalQty: number; grossWeightKg: number; netWeightKg: number };
}

interface Shipment {
  id: string; method: string | null; status: string; qty: number;
  promisedShippingDate: string | null; requiredDeliveryDate: string | null;
  actualShippingDate: string | null; trackingNumber: string | null; carrier: string | null;
  overrideApproved: boolean; overrideReason: string | null;
}

const SHIP_TONE: Record<string, string> = {
  NOT_READY: 'bg-ink-100 text-ink-600 ring-ink-500/20',
  READY: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  BOOKED: 'bg-accent-50 text-accent-700 ring-accent-600/20',
  SHIPPED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  DELIVERED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
};

export function PackingTab({ order }: { order: OrderDetailDto; focus?: "packing" | "shipping" }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [addingCarton, setAddingCarton] = useState<string | null>(null);
  const [shipping, setShipping] = useState(false);

  const lists = useQuery({ queryKey: ['packing', order.id], queryFn: () => api.packing.lists(order.id) });
  const shipments = useQuery({ queryKey: ['shipments', order.id], queryFn: () => api.packing.shipments(order.id) });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['packing', order.id] });
    void qc.invalidateQueries({ queryKey: ['shipments', order.id] });
    void qc.invalidateQueries({ queryKey: ['order', order.id] });
  };

  const createList = useMutation({ mutationFn: () => api.packing.createList(order.id), onSuccess: invalidate });
  const approve = useMutation({ mutationFn: (id: string) => api.packing.approve(id), onSuccess: invalidate });

  if (lists.isLoading || shipments.isLoading) return <Spinner />;

  const packingLists = (lists.data?.data ?? []) as unknown as PackingList[];
  const shipmentList = (shipments.data?.data ?? []) as unknown as Shipment[];
  const packedQty = order.funnel.find((f) => f.ledger === 'PACKED')?.qty ?? 0;
  const shippedQty = order.funnel.find((f) => f.ledger === 'SHIPPED')?.qty ?? 0;

  return (
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Produced" value={fmtNumber(order.production.producedQty)} />
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
                    <button onClick={() => setAddingCarton(l.id)} className="btn-secondary btn-sm">
                      <Plus className="h-3 w-3" /> Carton
                    </button>
                  )}
                  {can('packing:approve') && !l.approved && l.cartons.length > 0 && (
                    <button onClick={() => approve.mutate(l.id)} className="btn-primary btn-sm">Approve</button>
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
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {l.cartons.map((c) => (
                      <tr key={c.id}>
                        <td className="td font-mono text-xs">{c.cartonNumber}</td>
                        <td className="td text-xs">{c.cartonSize || '—'}</td>
                        <td className="td text-xs">{c.colorName || '—'}</td>
                        <td className="td text-xs">{c.sizeName || '—'}</td>
                        <td className="td text-right"><Num value={c.qty} /></td>
                        <td className="td text-right"><Num value={c.grossWeightKg} places={2} fallback="—" /></td>
                        <td className="td text-right"><Num value={c.netWeightKg} places={2} fallback="—" /></td>
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
                  <td className="td"><span className={clsx('chip', SHIP_TONE[s.status])}>{s.status.replace(/_/g, ' ')}</span></td>
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

      <CartonModal
        listId={addingCarton} order={order}
        onClose={() => setAddingCarton(null)}
        onDone={() => { setAddingCarton(null); invalidate(); }}
      />
      <ShipmentModal
        open={shipping} order={order} producedQty={order.production.producedQty}
        onClose={() => setShipping(false)}
        onDone={() => { setShipping(false); invalidate(); }}
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
            <select value={form.orderColorId} onChange={(e) => setForm({ ...form, orderColorId: e.target.value })} className="input">
              <option value="">Mixed / not specified</option>
              {matrix?.colors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Size">
            <select value={form.orderSizeId} onChange={(e) => setForm({ ...form, orderSizeId: e.target.value })} className="input">
              <option value="">Mixed / not specified</option>
              {matrix?.sizes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
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
  open, order, producedQty, onClose, onDone,
}: {
  open: boolean; order: OrderDetailDto; producedQty: number; onClose: () => void; onDone: () => void;
}) {
  const { can } = useAuth();
  const [form, setForm] = useState({
    status: 'READY', qty: '', carrier: '', trackingNumber: '',
    actualShippingDate: new Date().toISOString().slice(0, 10),
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const exceedsProduced = Number(form.qty) > producedQty && Number(form.qty) > 0;
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
          actualShippingDate: form.status === 'SHIPPED' ? form.actualShippingDate : undefined,
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
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input">
              {['NOT_READY', 'READY', 'BOOKED', 'SHIPPED', 'DELIVERED'].map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </Field>
          <Field label="Quantity" hint={`${producedQty.toLocaleString()} produced`}>
            <input type="number" min={0} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} className="input" />
          </Field>
          <Field label="Carrier"><input value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} className="input" /></Field>
          <Field label="Tracking / AWB"><input value={form.trackingNumber} onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })} className="input" /></Field>
          {form.status === 'SHIPPED' && (
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
              {Number(form.qty).toLocaleString()} pieces against {producedQty.toLocaleString()} produced.
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
