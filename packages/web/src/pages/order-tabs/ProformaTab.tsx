/**
 * Step 4 — Proforma Invoice.
 *
 * The quotation the factory sends before anything is made. In the workbook it
 * sits fourth, before external operations and before the progress plan: the
 * money is agreed first. Sheet `Proforma Invoice_Factory.Manger`, laid out as
 * it is there — header, consignee block, line table, grand total.
 *
 * Two things this screen refuses to do:
 *
 * **It does not invent totals.** A line with no quantity or no price has no
 * total, and shows "Not calculated" rather than 0.00. The workbook printed
 * `#VALUE!` in the same situation; a confident zero on a customer's document is
 * worse than either.
 *
 * **It does not let a sent invoice be edited.** Once it has gone to the
 * customer, the copy they hold is the document. The API refuses; this screen
 * says so before you type.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Send, Lock } from 'lucide-react';
import { fmtDate, type OrderDetailDto } from '@opsflow/shared';
import { api, type ProformaDto } from '../../lib/api';
import { Card, Field, Spinner, ConfirmDialog, Num, clsx, useToast } from '../../components/ui';

interface LineDraft {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
}

interface Draft {
  number: string;
  date: string;
  consignee: string;
  billingAddress: string;
  email: string;
  vesselVoyage: string;
  containerSeal: string;
  shippingDate: string;
  shipmentFrom: string;
  shipmentTo: string;
  consolidatingVendor: string;
  currency: string;
  terms: string;
  lines: LineDraft[];
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

/**
 * A first draft built from the order, not from thin air.
 *
 * This is the one place Phase 3 allows a suggestion: the consignee and the
 * quantity are facts already on the order, and re-typing them is the "don't
 * type it twice" rule the workbook breaks on every sheet. Everything else —
 * vessel, container, shipping date — is left blank, because guessing a
 * container number onto a customer's document is not a convenience.
 */
function seedFrom(order: OrderDetailDto): Draft {
  return {
    number: '',
    date: new Date().toISOString().slice(0, 10),
    consignee: order.client.name,
    billingAddress: order.client.billingAddress ?? '',
    email: '',
    vesselVoyage: '',
    containerSeal: '',
    shippingDate: day(order.promisedShippingDate),
    shipmentFrom: 'Cairo / Egypt',
    shipmentTo: '',
    consolidatingVendor: '',
    currency: 'USD',
    terms: '',
    lines: [{
      description: [order.styleNumber, order.orderName].filter(Boolean).join(' — '),
      quantity: String(order.stockDeduction.customerOrderQty || ''),
      unit: 'PCS',
      unitPrice: order.pricePerPieceUsd != null ? String(order.pricePerPieceUsd) : '',
    }],
  };
}

function fromServer(inv: ProformaDto): Draft {
  return {
    number: inv.number ?? '',
    date: day(inv.date),
    consignee: inv.consignee ?? '',
    billingAddress: inv.billingAddress ?? '',
    email: inv.email ?? '',
    vesselVoyage: inv.vesselVoyage ?? '',
    containerSeal: inv.containerSeal ?? '',
    shippingDate: day(inv.shippingDate),
    shipmentFrom: inv.shipmentFrom ?? '',
    shipmentTo: inv.shipmentTo ?? '',
    consolidatingVendor: inv.consolidatingVendor ?? '',
    currency: inv.currency,
    terms: inv.terms ?? '',
    lines: inv.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity != null ? String(l.quantity) : '',
      unit: l.unit,
      unitPrice: l.unitPrice != null ? String(l.unitPrice) : '',
    })),
  };
}

const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function ProformaTab({ order }: { order: OrderDetailDto }) {
  const orderId = order.id;
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['proforma', orderId],
    queryFn: () => api.steps.proforma(orderId),
  });

  const invoice = data?.data ?? null;
  const sent = invoice?.sentAt != null;

  useEffect(() => {
    if (isLoading) return;
    setDraft(invoice ? fromServer(invoice) : seedFrom(order));
    // Re-seeding on every render would fight the person typing; this runs when
    // the server's copy changes, which is what should reset the form.
  }, [invoice, isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['proforma', orderId] });
    qc.invalidateQueries({ queryKey: ['order-steps', orderId] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) => api.steps.saveProforma(orderId, {
      number: d.number.trim() || null,
      date: d.date || undefined,
      consignee: d.consignee.trim() || null,
      billingAddress: d.billingAddress.trim() || null,
      email: d.email.trim() || null,
      vesselVoyage: d.vesselVoyage.trim() || null,
      containerSeal: d.containerSeal.trim() || null,
      shippingDate: d.shippingDate || null,
      shipmentFrom: d.shipmentFrom.trim() || null,
      shipmentTo: d.shipmentTo.trim() || null,
      consolidatingVendor: d.consolidatingVendor.trim() || null,
      currency: d.currency.trim().toUpperCase() || 'USD',
      terms: d.terms.trim() || null,
      lines: d.lines
        .filter((l) => l.description.trim().length > 0)
        .map((l) => ({
          description: l.description.trim(),
          quantity: numOrNull(l.quantity),
          unit: l.unit.trim() || 'PCS',
          unitPrice: numOrNull(l.unitPrice),
        })),
    }),
    onSuccess: () => { refresh(); toast.success('Proforma invoice saved'); },
    onError: (e) => toast.error(e),
  });

  const send = useMutation({
    mutationFn: () => api.steps.sendProforma(orderId),
    onSuccess: () => { refresh(); setConfirmSend(false); toast.success('Marked as sent to the customer'); },
    onError: (e) => toast.error(e),
  });

  if (isLoading || !draft) return <Spinner label="Loading proforma invoice…" />;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setDraft({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  // The same arithmetic the server does, so the screen and the document agree.
  const lineTotal = (l: LineDraft): number | null => {
    const q = numOrNull(l.quantity);
    const p = numOrNull(l.unitPrice);
    return q != null && p != null ? q * p : null;
  };
  const priced = draft.lines.map(lineTotal).filter((t): t is number => t != null);
  const grand = priced.length > 0 ? priced.reduce((a, b) => a + b, 0) : null;
  const anyIncomplete = draft.lines.some((l) => l.description.trim() && lineTotal(l) == null);

  return (
    <div className="space-y-4 p-5">
      {sent && (
        <div className="flex items-start gap-2 rounded-md border border-ink-300 bg-ink-100 px-4 py-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
          <div className="text-sm text-ink-700">
            <p className="font-semibold">Sent to the customer on {fmtDate(invoice!.sentAt)}.</p>
            <p className="mt-0.5 text-xs">
              The customer holds this version, so it can no longer be edited. If the quotation has
              changed, the factory issues a revision with its own number.
            </p>
          </div>
        </div>
      )}

      <Card>
        <div className="card-header">
          <h3 className="card-title">Proforma invoice</h3>
          <div className="flex gap-2">
            <button
              className="btn-ghost btn-sm"
              disabled={sent || save.isPending}
              onClick={() => save.mutate(draft)}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              className="btn-primary btn-sm"
              disabled={sent || !invoice || invoice.lines.length === 0}
              onClick={() => setConfirmSend(true)}
              title={!invoice ? 'Save the invoice first' : undefined}
            >
              <Send className="h-3.5 w-3.5" /> Mark as sent
            </button>
          </div>
        </div>

        <fieldset disabled={sent} className={clsx('space-y-4 p-4', sent && 'opacity-70')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Proforma invoice no." hint="The factory's own numbering.">
              <input className="input" value={draft.number} onChange={(e) => set('number', e.target.value)} />
            </Field>
            <Field label="Date">
              <input type="date" className="input" value={draft.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
            <Field label="Currency">
              <input className="input uppercase" maxLength={3} value={draft.currency} onChange={(e) => set('currency', e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="To" hint="Taken from the order's client, and editable — the document keeps what was sent.">
              <input className="input" value={draft.consignee} onChange={(e) => set('consignee', e.target.value)} />
            </Field>
            <Field label="Email">
              <input className="input" type="email" value={draft.email} onChange={(e) => set('email', e.target.value)} />
            </Field>
            <Field label="Billing address">
              <textarea className="input min-h-[4rem]" value={draft.billingAddress} onChange={(e) => set('billingAddress', e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Shipment from">
                <input className="input" value={draft.shipmentFrom} onChange={(e) => set('shipmentFrom', e.target.value)} />
              </Field>
              <Field label="Shipment to">
                <input className="input" value={draft.shipmentTo} onChange={(e) => set('shipmentTo', e.target.value)} />
              </Field>
              <Field label="Vessel / voyage">
                <input className="input" value={draft.vesselVoyage} onChange={(e) => set('vesselVoyage', e.target.value)} />
              </Field>
              <Field label="Container / seal #">
                <input className="input" value={draft.containerSeal} onChange={(e) => set('containerSeal', e.target.value)} />
              </Field>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Shipping date">
              <input type="date" className="input" value={draft.shippingDate} onChange={(e) => set('shippingDate', e.target.value)} />
            </Field>
            <Field label="Consolidating vendor">
              <input className="input" value={draft.consolidatingVendor} onChange={(e) => set('consolidatingVendor', e.target.value)} />
            </Field>
          </div>

          {/* ── Lines ─────────────────────────────────────────────────── */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="label mb-0">Items</span>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setDraft({
                  ...draft,
                  lines: [...draft.lines, { description: '', quantity: '', unit: 'PCS', unitPrice: '' }],
                })}
              >
                <Plus className="h-3.5 w-3.5" /> Add a line
              </button>
            </div>

            <table className="w-full border border-ink-200">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Item / description</th>
                  <th className="th w-28 text-right">Qty</th>
                  <th className="th w-20">Unit</th>
                  <th className="th w-32 text-right">Unit price</th>
                  <th className="th w-32 text-right">Total</th>
                  <th className="th w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {draft.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="p-1">
                      <input
                        className="input border-transparent bg-transparent"
                        value={l.description}
                        placeholder="Style — description"
                        onChange={(e) => setLine(i, { description: e.target.value })}
                      />
                    </td>
                    <td className="p-1">
                      <input
                        className="input tnum border-transparent bg-transparent text-right"
                        value={l.quantity}
                        onChange={(e) => setLine(i, { quantity: e.target.value })}
                      />
                    </td>
                    <td className="p-1">
                      <input
                        className="input border-transparent bg-transparent"
                        value={l.unit}
                        onChange={(e) => setLine(i, { unit: e.target.value })}
                      />
                    </td>
                    <td className="p-1">
                      <input
                        className="input tnum border-transparent bg-transparent text-right"
                        value={l.unitPrice}
                        onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                      />
                    </td>
                    <td className="td tnum text-right font-semibold">
                      <Num value={lineTotal(l)} kind="money" places={2} />
                    </td>
                    <td className="p-1 text-right">
                      <button
                        type="button"
                        className="btn-ghost btn-sm text-red-600 hover:bg-red-50"
                        onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}
                        aria-label="Remove line"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-ink-300 bg-ink-50">
                <tr>
                  <td className="td font-semibold" colSpan={4}>Grand total ({draft.currency})</td>
                  <td className="td tnum text-right text-base font-semibold">
                    <Num value={grand} kind="money" places={2} />
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>

            {anyIncomplete && (
              <p className="mt-1.5 text-2xs text-amber-800">
                A line with no quantity or no price has no total, and is left out of the grand
                total rather than counted as zero.
              </p>
            )}
          </div>

          <Field
            label="Terms and conditions"
            hint="Origin, payment terms, bank details. Stored with this invoice, so an old one still reads as it was sent."
          >
            <textarea
              className="input min-h-[6rem] font-mono text-xs"
              value={draft.terms}
              onChange={(e) => set('terms', e.target.value)}
              placeholder={
                '1  Goods are of Egyptian origin.\n' +
                '2  Prices are FOB; 100% down payment.\n' +
                '3  Payment to the account below.'
              }
            />
          </Field>
        </fieldset>
      </Card>

      <ConfirmDialog
        open={confirmSend}
        onCancel={() => setConfirmSend(false)}
        onConfirm={() => send.mutate()}
        busy={send.isPending}
        tone="primary"
        title="Mark this proforma invoice as sent?"
        confirmLabel="Yes, it has been sent"
        body={
          <>
            <p>
              This records that the customer now holds this quotation. It cannot be edited
              afterwards — a changed quotation is a new revision with its own number.
            </p>
            <p className="mt-2">
              OpsFlow does not email it. Send it however you normally do, then record it here.
            </p>
          </>
        }
      />
    </div>
  );
}
