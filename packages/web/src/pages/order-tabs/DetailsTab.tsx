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
    poNumber: order.poNumber,
    clientId: order.client.id,
    coordinatorId: order.coordinator?.id ?? '',
    outsideWorkManagerId: order.outsideWorkManager?.id ?? '',
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
    internalPoDate: order.internalPoDate?.slice(0, 10) ?? '',
    productionSample: order.productionSample,
    shippingAddress: order.shippingAddress ?? '',
    billingAddress: order.billingAddress ?? '',
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

      {/* ── Order Details_Coordinator ────────────────────────────────────
          Laid out as the workbook sheet is: the order's own facts down the
          left, the addresses and free-text blocks down the right, in the same
          sequence, because the people filling this in have the sheet in front
          of them and read down it. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Order details" subtitle="The order as the customer placed it." />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Picker label="Customer" editing={editing} value={form.clientId}
              options={(lookups?.clients ?? []).map((c) => ({ id: c.id, name: c.name }))}
              onChange={(v) => setForm({ ...form, clientId: v })} display={order.client.name} />
            <Edit label="Customer PO" editing={editing} value={form.externalReference}
              onChange={(v) => setForm({ ...form, externalReference: v })}
              display={order.externalReference} hint="The customer's own number for this order." />
            <Edit label="Customer PO date" editing={editing} type="date" value={form.poDate}
              onChange={(v) => setForm({ ...form, poDate: v })} display={fmtDate(order.poDate)} />
            <Edit label="Required delivery date" editing={editing} type="date" value={form.requiredDeliveryDate}
              onChange={(v) => setForm({ ...form, requiredDeliveryDate: v })} display={fmtDate(order.requiredDeliveryDate)} />
            <Select label="Season" editing={editing} value={form.season} options={values.SEASON?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, season: v })} display={order.season} />

            <Edit label="Internal PO no." editing={editing} value={form.poNumber}
              onChange={(v) => setForm({ ...form, poNumber: v })} display={order.poNumber}
              hint="The order's own number. Changing it is refused if another order already has it." />
            <Edit label="Internal PO date" editing={editing} type="date" value={form.internalPoDate}
              onChange={(v) => setForm({ ...form, internalPoDate: v })} display={fmtDate(order.internalPoDate)} />
            <Edit label="Order name" editing={editing} value={form.orderName}
              onChange={(v) => setForm({ ...form, orderName: v })} display={order.orderName} />

            {/* Three states, not two: nobody has said yet is not the same as no,
                and the sheet colours an unanswered cell for exactly that reason. */}
            <div>
              <p className="label">Production sample</p>
              {editing ? (
                <select
                  className="input"
                  value={form.productionSample == null ? '' : form.productionSample ? 'yes' : 'no'}
                  onChange={(e) => setForm({
                    ...form,
                    productionSample: e.target.value === '' ? null : e.target.value === 'yes',
                  })}
                >
                  <option value="">Not decided</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              ) : (
                <p className={clsx(
                  'text-sm',
                  order.productionSample === false ? 'font-semibold text-red-700' : 'text-ink-800',
                )}>
                  {order.productionSample == null ? '—' : order.productionSample ? 'Yes' : 'No'}
                </p>
              )}
            </div>

            <Select label="Item type" editing={editing} value={form.itemType} options={values.ITEM_TYPE?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, itemType: v })} display={order.itemType} />
            <Select label="Gender" editing={editing} value={form.gender} options={values.GENDER?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, gender: v })} display={order.gender} />
            <Edit label="Style no." editing={editing} value={form.styleNumber}
              onChange={(v) => setForm({ ...form, styleNumber: v })} display={order.styleNumber} />
            <Picker label="Coordinator" editing={editing} value={form.coordinatorId}
              options={(lookups?.users ?? []).map((u) => ({ id: u.id, name: u.name }))}
              onChange={(v) => setForm({ ...form, coordinatorId: v })} display={order.coordinator?.name}
              hint="Who owns this order. Anyone may still open it." />
            <Picker label="Outside work manager" editing={editing} value={form.outsideWorkManagerId}
              options={(lookups?.users ?? []).map((u) => ({ id: u.id, name: u.name }))}
              onChange={(v) => setForm({ ...form, outsideWorkManagerId: v })} display={order.outsideWorkManager?.name} />
            <Edit label="Price in US$" editing={editing} type="number" step="0.01" value={String(form.pricePerPieceUsd)}
              onChange={(v) => setForm({ ...form, pricePerPieceUsd: Number(v) })}
              display={order.pricePerPieceUsd != null ? `$${order.pricePerPieceUsd.toFixed(2)}` : null} />
            <Select label="Method of shipping" editing={editing} value={form.shippingMethod} options={values.SHIPPING_METHOD?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, shippingMethod: v })} display={order.shippingMethod} />
            <Edit label="Cut percentage" editing={editing} type="number" step="0.01" value={String(form.cutPercentage)}
              onChange={(v) => setForm({ ...form, cutPercentage: Number(v) })}
              display={`${(order.cutPercentage * 100).toFixed(1)}%`}
              hint="A fraction — 0.05 means 5%. Drives the cut order." />
            <Select label="Fabric" editing={editing} value={form.fabric} options={values.FABRIC?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, fabric: v })} display={order.fabric} />
            <Select label="Fit" editing={editing} value={form.fit} options={values.FIT?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, fit: v })} display={order.fit} />
            <Select label="Block pattern" editing={editing} value={form.blockPattern} options={values.BLOCK_PATTERN?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, blockPattern: v })} display={order.blockPattern} />
            <Edit label="Accessory percentage" editing={editing} type="number" step="0.01" value={String(form.accessoryPercentage)}
              onChange={(v) => setForm({ ...form, accessoryPercentage: Number(v) })}
              display={`${(order.accessoryPercentage * 100).toFixed(1)}%`} />
            <Edit label="Promised shipping" editing={editing} type="date" value={form.promisedShippingDate}
              onChange={(v) => setForm({ ...form, promisedShippingDate: v })} display={fmtDate(order.promisedShippingDate)} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Addresses and instructions" subtitle="Where it ships, and what the floor must know." />
          <div className="space-y-3 p-4">
            <AddressPicker
              label="Shipping address"
              editing={editing}
              value={form.shippingAddress}
              options={values.SHIPPING_ADDRESS?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, shippingAddress: v })}
              display={order.client.shippingAddress}
              hint="Pick one, or type an address that is not on the list."
            />
            <AddressPicker
              label="Billing address"
              editing={editing}
              value={form.billingAddress}
              options={values.SHIPPING_ADDRESS?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, billingAddress: v })}
              display={order.client.billingAddress}
            />

            <div>
              <p className="label">General notes</p>
              {editing ? (
                <textarea className="input min-h-[5rem]" value={form.notes.general ?? ''}
                  onChange={(e) => setForm({ ...form, notes: { ...form.notes, general: e.target.value } })} />
              ) : (
                <FreeText text={order.notes.general} />
              )}
            </div>

            <div>
              <p className="label">Packing instructions</p>
              {editing ? (
                <textarea className="input min-h-[5rem]" value={form.notes.packing ?? ''}
                  onChange={(e) => setForm({ ...form, notes: { ...form.notes, packing: e.target.value } })} />
              ) : (
                <FreeText text={order.notes.packing} />
              )}
            </div>
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

/**
 * An address chosen from the list, or typed.
 *
 * A dropdown alone would be wrong: these four are the addresses used today, not
 * the only ones that will ever exist, and a customer with a new warehouse must
 * not be unshippable until somebody edits reference data. So the list fills the
 * field and the field stays editable — which is also how the workbook's own
 * validation behaves.
 */
function AddressPicker({
  label, editing, value, options, onChange, display, hint,
}: {
  label: string; editing: boolean; value: string; options: string[];
  onChange: (v: string) => void; display: string | null | undefined; hint?: string;
}) {
  if (!editing) {
    return (
      <div>
        <p className="label">{label}</p>
        <p className="whitespace-pre-line text-sm text-ink-800">{display || '—'}</p>
      </div>
    );
  }

  return (
    <div>
      <p className="label">{label}</p>
      <select
        className="input mb-1.5"
        value={options.includes(value) ? value : ''}
        onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
      >
        <option value="">Choose a saved address…</option>
        {options.map((o) => (
          <option key={o} value={o}>{o.length > 70 ? `${o.slice(0, 70)}…` : o}</option>
        ))}
      </select>
      <textarea
        className="input min-h-[3.5rem]"
        value={value}
        placeholder="Or type an address"
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="mt-1 text-2xs text-ink-500">{hint}</p>}
    </div>
  );
}

/**
 * A person or a client, chosen by name and stored by id.
 *
 * Separate from `Select`, which works in plain strings for reference values.
 * Here the displayed text and the saved value are different things, and
 * conflating them is how a coordinator's name ends up in a foreign key column.
 */
function Picker({
  label, editing, value, options, onChange, display, hint,
}: {
  label: string; editing: boolean; value: string;
  options: Array<{ id: string; name: string }>;
  onChange: (v: string) => void; display: string | null | undefined; hint?: string;
}) {
  return (
    <div>
      <p className="label">{label}</p>
      {editing ? (
        <>
          <select value={value} onChange={(e) => onChange(e.target.value)} className="input">
            <option value="">—</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          {hint && <p className="mt-1 text-2xs text-ink-500">{hint}</p>}
        </>
      ) : (
        <p className="text-sm text-ink-800">{display || '—'}</p>
      )}
    </div>
  );
}
