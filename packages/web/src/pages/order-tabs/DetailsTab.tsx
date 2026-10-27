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
import { Card, CardHeader, FreeText, ErrorNote, clsx } from '../../components/ui';
import { ComboSelect } from '../../components/ComboSelect';

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
    // Blank stays blank. Defaulting to 0 saved a price of $0 on every order
    // whose details were saved before the price was known, and the costing then
    // reported the whole cost as a loss.
    pricePerPieceUsd: order.pricePerPieceUsd == null ? '' : String(order.pricePerPieceUsd),
    samMinutes: order.samMinutes == null ? '' : String(order.samMinutes),
    // Typed as a percentage (5), stored as a fraction (0.05).
    cutPercentText: percentText(order.cutPercentage),
    accessoryPercentText: percentText(order.accessoryPercentage),
    poDate: order.poDate?.slice(0, 10) ?? '',
    internalPoDate: order.internalPoDate?.slice(0, 10) ?? '',
    productionSample: order.productionSample,
    productionSampleNote: order.productionSampleNote ?? '',
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

  /**
   * A percentage as typed, as the stored fraction, or the reason it cannot be
   * saved. Blank is refused rather than read as 0%, which would cut with no
   * allowance; and a figure under 1 is refused because it is almost always the
   * old fraction habit (0.05 meaning 5%), which would store 0.05%.
   */
  const percentField = (label: string, text: string): number => {
    const v = Number(text);
    if (text.trim() === '' || !Number.isFinite(v)) throw new Error(`${label}: type a percentage, e.g. 5 for 5%.`);
    if (v > 0 && v < 1) throw new Error(`${label} of ${text}% is under 1%. Type the percentage itself: 5 means 5%.`);
    // Four places, as the column stores it: 5.8 / 100 is 0.057999… otherwise.
    return Number((v / 100).toFixed(4));
  };

  const save = useMutation({
    mutationFn: () =>
      api.orders.update(order.id, {
        ...withoutKeys(form, ['cutPercentText', 'accessoryPercentText']),
        pricePerPieceUsd: form.pricePerPieceUsd === '' ? null : Number(form.pricePerPieceUsd),
        samMinutes: form.samMinutes === '' ? null : Number(form.samMinutes),
        cutPercentage: percentField('Cut percentage', form.cutPercentText),
        accessoryPercentage: percentField('Accessory percentage', form.accessoryPercentText),
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
    onError: (e) => setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not save.'),
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

            {/* Yes, No, Not decided — or a comment typed instead ("Sent 20 Oct").
                Nobody has said yet is not the same as no, and a comment is the
                answer when there is one. */}
            <div>
              <p className="label">Production sample</p>
              {editing ? (
                <>
                  <ComboSelect
                    allowCustom
                    maxLength={300}
                    className="input"
                    placeholder="Choose, or type a comment"
                    value={form.productionSampleNote || (form.productionSample == null ? '' : form.productionSample ? 'yes' : 'no')}
                    onChange={(e) => {
                      const v = e.target.value;
                      setForm(v === '' || v === 'yes' || v === 'no'
                        ? { ...form, productionSample: v === '' ? null : v === 'yes', productionSampleNote: '' }
                        : { ...form, productionSample: null, productionSampleNote: v });
                    }}
                  >
                    <option value="">Not decided</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </ComboSelect>
                  <p className="mt-1 text-xs text-ink-500">Pick one, or type a comment. It is saved with Save changes.</p>
                </>
              ) : (
                <p className={clsx(
                  'text-sm',
                  !order.productionSampleNote && order.productionSample === false ? 'font-semibold text-red-700' : 'text-ink-800',
                )}>
                  {order.productionSampleNote
                    ?? (order.productionSample == null ? '—' : order.productionSample ? 'Yes' : 'No')}
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
            <Edit label="Price in US$" editing={editing} type="number" step="0.01" value={form.pricePerPieceUsd}
              onChange={(v) => setForm({ ...form, pricePerPieceUsd: v })}
              display={order.pricePerPieceUsd != null ? `$${order.pricePerPieceUsd.toFixed(2)}` : null} />
            <Select label="Method of shipping" editing={editing} value={form.shippingMethod} options={values.SHIPPING_METHOD?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, shippingMethod: v })} display={order.shippingMethod} />
            <Edit label="Cut percentage (%)" editing={editing} type="number" step="0.1" value={form.cutPercentText}
              onChange={(v) => setForm({ ...form, cutPercentText: v })}
              display={`${percentText(order.cutPercentage)}%`}
              hint="Type the percentage: 5 means 5%. Drives the cut order." />
            <Select label="Fabric" editing={editing} value={form.fabric} options={values.FABRIC?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, fabric: v })} display={order.fabric} />
            <Select label="Fit" editing={editing} value={form.fit} options={values.FIT?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, fit: v })} display={order.fit} />
            <Select label="Block pattern" editing={editing} value={form.blockPattern} options={values.BLOCK_PATTERN?.map((v) => v.value) ?? []}
              onChange={(v) => setForm({ ...form, blockPattern: v })} display={order.blockPattern} />
            <Edit label="Accessory percentage (%)" editing={editing} type="number" step="0.1" value={form.accessoryPercentText}
              onChange={(v) => setForm({ ...form, accessoryPercentText: v })}
              display={`${percentText(order.accessoryPercentage)}%`}
              hint="Type the percentage: 5 means 5%." />
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

    </div>
  );
}


/** The form without the fields that exist only on screen. */
function withoutKeys<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Omit<T, K> {
  const rest = { ...o };
  for (const k of keys) delete rest[k];
  return rest;
}

/** A stored fraction as the percentage a person types: 0.05 → "5", 0.025 → "2.5". */
const percentText = (fraction: number): string => String(Number((fraction * 100).toFixed(4)));

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
        <ComboSelect allowCustom value={value} onChange={(e) => onChange(e.target.value)} className="input">
          <option value="">—</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </ComboSelect>
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
      <ComboSelect
        allowCustom
        className="input mb-1.5"
        value={options.includes(value) ? value : ''}
        onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
      >
        <option value="">Choose a saved address…</option>
        {options.map((o) => (
          <option key={o} value={o}>{o.length > 70 ? `${o.slice(0, 70)}…` : o}</option>
        ))}
      </ComboSelect>
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
          <ComboSelect value={value} onChange={(e) => onChange(e.target.value)} className="input">
            <option value="">—</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </ComboSelect>
          {hint && <p className="mt-1 text-2xs text-ink-500">{hint}</p>}
        </>
      ) : (
        <p className="text-sm text-ink-800">{display || '—'}</p>
      )}
    </div>
  );
}
