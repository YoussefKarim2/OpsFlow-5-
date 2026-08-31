/**
 * Order details — the fields from `Order Details_Coordinator`, editable by
 * permission. In the workbook twelve other sheets mirrored these values with
 * `='Order Details'!Dn` formulas; here they are stored once and read everywhere.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Pencil } from 'lucide-react';
import { fmtDate, type OrderDetailDto } from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Card, CardHeader, Field, FreeText, ErrorNote, clsx } from '../../components/ui';

export function DetailsTab({ order }: { order: OrderDetailDto }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: lookups } = useQuery({ queryKey: ['lookups'], queryFn: api.reference.lookups });

  const [form, setForm] = useState({
    orderName: order.orderName,
    season: order.season,
    itemType: order.itemType ?? '',
    gender: order.gender ?? '',
    styleNumber: order.styleNumber ?? '',
    fit: order.fit ?? '',
    blockPattern: order.blockPattern ?? '',
    fabric: order.fabric ?? '',
    shippingMethod: order.shippingMethod ?? '',
    pricePerPieceUsd: order.pricePerPieceUsd ?? 0,
    cutPercentage: order.cutPercentage,
    accessoryPercentage: order.accessoryPercentage,
    poDate: order.poDate?.slice(0, 10) ?? '',
    promisedShippingDate: order.promisedShippingDate?.slice(0, 10) ?? '',
    requiredDeliveryDate: order.requiredDeliveryDate?.slice(0, 10) ?? '',
    externalReference: order.externalReference ?? '',
    externalWorkSort: order.externalWorkSort ?? '',
    externalWorkType: order.externalWorkType ?? '',
    priority: order.priority,
    notes: { ...order.notes },
  });

  const save = useMutation({
    mutationFn: () =>
      api.orders.update(order.id, {
        ...form,
        pricePerPieceUsd: Number(form.pricePerPieceUsd),
        cutPercentage: Number(form.cutPercentage),
        accessoryPercentage: Number(form.accessoryPercentage),
        notes: {
          general: form.notes.general ?? '', spread: form.notes.spread ?? '',
          cut: form.notes.cut ?? '', packing: form.notes.packing ?? '',
          external: form.notes.external ?? '',
        },
      }),
    onSuccess: () => {
      setEditing(false); setError(null);
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  });

  const editable = can('order:edit');
  const values = lookups?.values ?? {};

  return (
    <div className="space-y-4 p-5">
      {error && <ErrorNote error={new Error(error)} />}

      <div className="flex justify-end gap-2">
        {editable && !editing && (
          <button onClick={() => setEditing(true)} className="btn-secondary btn-sm">
            <Pencil className="h-3.5 w-3.5" /> Edit details
          </button>
        )}
        {editing && (
          <>
            <button onClick={() => setEditing(false)} className="btn-secondary btn-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary btn-sm">
              <Save className="h-3.5 w-3.5" />{save.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Product" />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Row label="PO number" value={order.poNumber} mono />
            <Edit label="Order name" editing={editing} value={form.orderName}
              onChange={(v) => setForm({ ...form, orderName: v })} display={order.orderName} />
            <Select label="Season" editing={editing} value={form.season} options={values.SEASON?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, season: v })} display={order.season} />
            <Select label="Item type" editing={editing} value={form.itemType} options={values.ITEM_TYPE?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, itemType: v })} display={order.itemType} />
            <Select label="Gender" editing={editing} value={form.gender} options={values.GENDER?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, gender: v })} display={order.gender} />
            <Edit label="Style number" editing={editing} value={form.styleNumber}
              onChange={(v) => setForm({ ...form, styleNumber: v })} display={order.styleNumber} />
            <Select label="Fit" editing={editing} value={form.fit} options={values.FIT?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, fit: v })} display={order.fit} />
            <Select label="Block pattern" editing={editing} value={form.blockPattern} options={values.BLOCK_PATTERN?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, blockPattern: v })} display={order.blockPattern} />
            <Select label="Fabric" editing={editing} value={form.fabric} options={values.FABRIC?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, fabric: v })} display={order.fabric} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Commercial & dates" />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Row label="Client" value={order.client.name} />
            <Row label="Coordinator" value={order.coordinator?.name} />
            <Row label="Outside work manager" value={order.outsideWorkManager?.name} />
            <Row label="External factory" value={order.externalFactory?.name} />
            <Edit label="Price per piece (USD)" editing={editing} type="number" value={String(form.pricePerPieceUsd)}
              onChange={(v) => setForm({ ...form, pricePerPieceUsd: Number(v) })}
              display={order.pricePerPieceUsd != null ? `$${order.pricePerPieceUsd.toFixed(2)}` : null} />
            <Select label="Shipping method" editing={editing} value={form.shippingMethod} options={values.SHIPPING_METHOD?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, shippingMethod: v })} display={order.shippingMethod} />
            <Edit label="Cut percentage" editing={editing} type="number" step="0.01" value={String(form.cutPercentage)}
              onChange={(v) => setForm({ ...form, cutPercentage: Number(v) })}
              display={`${(order.cutPercentage * 100).toFixed(1)}%`}
              hint="A fraction — 0.05 means 5%. Drives the cut order." />
            <Edit label="Accessory percentage" editing={editing} type="number" step="0.01" value={String(form.accessoryPercentage)}
              onChange={(v) => setForm({ ...form, accessoryPercentage: Number(v) })}
              display={`${(order.accessoryPercentage * 100).toFixed(1)}%`} />
            <Edit label="PO date" editing={editing} type="date" value={form.poDate}
              onChange={(v) => setForm({ ...form, poDate: v })} display={fmtDate(order.poDate)} />
            <Edit label="Promised shipping" editing={editing} type="date" value={form.promisedShippingDate}
              onChange={(v) => setForm({ ...form, promisedShippingDate: v })} display={fmtDate(order.promisedShippingDate)} />
            <Edit label="Required delivery" editing={editing} type="date" value={form.requiredDeliveryDate}
              onChange={(v) => setForm({ ...form, requiredDeliveryDate: v })} display={fmtDate(order.requiredDeliveryDate)} />
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="External work" />
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <Edit label="External reference" editing={editing} value={form.externalReference}
            onChange={(v) => setForm({ ...form, externalReference: v })} display={order.externalReference} />
          <Select label="Work sort" editing={editing} value={form.externalWorkSort} options={values.EXTERNAL_WORK_SORT?.map((v) => v.value) ?? []}
            onChange={(v) => setForm({ ...form, externalWorkSort: v })} display={order.externalWorkSort} />
          <div>
            <p className="label">Work type</p>
            {editing ? (
              <select
                value={form.externalWorkType}
                onChange={(e) => setForm({ ...form, externalWorkType: e.target.value })}
                className="input"
              >
                <option value="">—</option>
                {(values.EXTERNAL_WORK_TYPE ?? []).map((v) => (
                  <option key={v.id} value={v.valueAr ?? v.value}>
                    {v.value}{v.valueAr ? ` — ${v.valueAr}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-sm text-ink-800"><FreeText text={order.externalWorkType} /></div>
            )}
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Addresses" />
          <div className="grid gap-4 p-4">
            <div>
              <p className="label">Shipping address</p>
              <div className="rounded border border-ink-200 bg-ink-50 px-3 py-2 text-sm leading-relaxed text-ink-800">
                <FreeText text={order.client.shippingAddress} />
              </div>
            </div>
            <div>
              <p className="label">Billing address</p>
              <div className="rounded border border-ink-200 bg-ink-50 px-3 py-2 text-sm leading-relaxed text-ink-800">
                <FreeText text={order.client.billingAddress} />
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Notes" subtitle="Read by the departments they concern" />
          <div className="grid gap-3 p-4">
            {(['general', 'spread', 'cut', 'packing', 'external'] as const).map((k) => (
              <Field key={k} label={k.charAt(0).toUpperCase() + k.slice(1)}>
                {editing ? (
                  <textarea
                    value={form.notes[k] ?? ''} rows={2}
                    onChange={(e) => setForm({ ...form, notes: { ...form.notes, [k]: e.target.value } })}
                    className="input"
                    dir="auto"
                  />
                ) : (
                  <div className="min-h-[2rem] rounded border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-800">
                    <FreeText text={order.notes[k]} />
                  </div>
                )}
              </Field>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p className={clsx('text-sm text-ink-800', mono && 'font-mono font-semibold')}>{value || '—'}</p>
    </div>
  );
}

function Edit({
  label, editing, value, onChange, display, type = 'text', step, hint,
}: {
  label: string; editing: boolean; value: string; onChange: (v: string) => void;
  display: string | null | undefined; type?: string; step?: string; hint?: string;
}) {
  return (
    <div>
      <p className="label">{label}</p>
      {editing ? (
        <>
          <input type={type} step={step} value={value} onChange={(e) => onChange(e.target.value)} className="input" />
          {hint && <p className="mt-1 text-2xs text-ink-500">{hint}</p>}
        </>
      ) : (
        <p className="text-sm text-ink-800">{display || '—'}</p>
      )}
    </div>
  );
}

function Select({
  label, editing, value, options, onChange, display,
}: {
  label: string; editing: boolean; value: string; options: string[];
  onChange: (v: string) => void; display: string | null | undefined;
}) {
  return (
    <div>
      <p className="label">{label}</p>
      {editing ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} className="input">
          <option value="">—</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <p className="text-sm text-ink-800">{display || '—'}</p>
      )}
    </div>
  );
}
