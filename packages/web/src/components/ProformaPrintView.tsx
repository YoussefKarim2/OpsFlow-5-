/**
 * The proforma invoice as a printed document.
 *
 * Rendered alongside the editor and hidden on screen; the print stylesheet in
 * `index.css` hides the application and shows this instead. That is why there is
 * no second route and no second fetch: the invoice on the page is already the
 * one the user is looking at, and two renderings that must be kept in step
 * forever is a bug waiting rather than a feature.
 *
 * It reads what is stored. It has no notion of whether the invoice was imported
 * from a customer's file or typed by hand, so both print identically — which is
 * the only sane answer, since the stored document is the same either way.
 *
 * Nothing is invented. The company block carries the application's own name and
 * the shipment origin the invoice actually holds; there is no stored Soccertex
 * address, VAT number or registration in this system, and printing a plausible
 * one would be putting a fabricated legal detail on a customer document.
 */

import { fmtDate } from '@opsflow/shared';

export interface PrintLine {
  description: string;
  quantity: number | null;
  unit: string;
  unitPrice: number | null;
}

export interface PrintInvoice {
  number: string | null;
  date: string | null;
  consignee: string | null;
  billingAddress: string | null;
  email: string | null;
  shipmentFrom: string | null;
  shipmentTo: string | null;
  vesselVoyage: string | null;
  containerSeal: string | null;
  shippingDate: string | null;
  consolidatingVendor: string | null;
  currency: string;
  terms: string | null;
  lines: PrintLine[];
  sentAt?: string | null;
}

const money = (n: number | null, currency: string) =>
  n == null ? '—' : `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const lineTotal = (l: PrintLine) =>
  l.quantity == null || l.unitPrice == null ? null : l.quantity * l.unitPrice;

/** A labelled value, omitted entirely when empty — blanks are noise on paper. */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-36 shrink-0 text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</span>
      <span className="text-sm text-ink-900">{value}</span>
    </div>
  );
}

export function ProformaPrintView({
  invoice, poNumber, orderName,
}: {
  invoice: PrintInvoice;
  poNumber: string;
  orderName: string;
}) {
  const total = invoice.lines.reduce((a, l) => a + (lineTotal(l) ?? 0), 0);
  const totalQty = invoice.lines.reduce((a, l) => a + (l.quantity ?? 0), 0);
  const unpriced = invoice.lines.some((l) => lineTotal(l) == null);

  return (
    <div className="print-only print-document">
      {/* ── Letterhead ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between border-b-2 border-ink-900 pb-3">
        <div>
          <p className="text-xl font-bold tracking-tight text-ink-900">Soccertex</p>
          {invoice.shipmentFrom ? (
            <p className="mt-0.5 text-sm text-ink-600">{invoice.shipmentFrom}</p>
          ) : null}
        </div>
        <div className="text-right">
          <p className="text-lg font-bold uppercase tracking-widest text-ink-900">Proforma Invoice</p>
          {invoice.number ? (
            <p className="mt-0.5 text-sm font-semibold text-ink-700">No. {invoice.number}</p>
          ) : null}
          {invoice.date ? (
            <p className="text-sm text-ink-600">{fmtDate(invoice.date)}</p>
          ) : null}
        </div>
      </div>

      {/* ── Parties and shipment ───────────────────────────────────────── */}
      <div className="mt-4 grid grid-cols-2 gap-6">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Consignee</p>
          <p className="text-sm font-semibold text-ink-900">{invoice.consignee || '—'}</p>
          {invoice.billingAddress ? (
            <p className="mt-0.5 whitespace-pre-line text-sm text-ink-700">{invoice.billingAddress}</p>
          ) : null}
          {invoice.email ? <p className="mt-0.5 text-sm text-ink-700">{invoice.email}</p> : null}
        </div>
        <div>
          <Row label="Order" value={`PO ${poNumber} — ${orderName}`} />
          <Row label="Ship from" value={invoice.shipmentFrom} />
          <Row label="Ship to" value={invoice.shipmentTo} />
          <Row label="Shipping date" value={invoice.shippingDate ? fmtDate(invoice.shippingDate) : null} />
          <Row label="Vessel / voyage" value={invoice.vesselVoyage} />
          <Row label="Container / seal" value={invoice.containerSeal} />
          <Row label="Consolidator" value={invoice.consolidatingVendor} />
        </div>
      </div>

      {/* ── Items ──────────────────────────────────────────────────────── */}
      <table className="mt-5 w-full border-collapse">
        <thead>
          <tr className="border-y border-ink-400">
            <th className="py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-600">Description</th>
            <th className="py-1.5 text-right text-xs font-semibold uppercase tracking-wide text-ink-600">Qty</th>
            <th className="py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-600 pl-3">Unit</th>
            <th className="py-1.5 text-right text-xs font-semibold uppercase tracking-wide text-ink-600">Unit price</th>
            <th className="py-1.5 text-right text-xs font-semibold uppercase tracking-wide text-ink-600">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-4 text-center text-sm text-ink-500">
                This invoice has no items.
              </td>
            </tr>
          ) : null}
          {invoice.lines.map((l, i) => (
            <tr key={i} className="border-b border-ink-200">
              <td className="py-1.5 pr-3 text-sm text-ink-900">{l.description}</td>
              <td className="py-1.5 text-right text-sm tabular-nums text-ink-900">
                {l.quantity == null ? '—' : l.quantity.toLocaleString()}
              </td>
              <td className="py-1.5 pl-3 text-sm text-ink-700">{l.unit}</td>
              <td className="py-1.5 text-right text-sm tabular-nums text-ink-900">
                {money(l.unitPrice, invoice.currency)}
              </td>
              <td className="py-1.5 text-right text-sm tabular-nums font-medium text-ink-900">
                {money(lineTotal(l), invoice.currency)}
              </td>
            </tr>
          ))}
        </tbody>
        {invoice.lines.length > 0 ? (
          <tfoot>
            <tr className="border-t-2 border-ink-900">
              <td className="py-2 text-sm font-semibold text-ink-900">Total</td>
              <td className="py-2 text-right text-sm tabular-nums font-semibold text-ink-900">
                {totalQty.toLocaleString()}
              </td>
              <td colSpan={2} />
              <td className="py-2 text-right text-base tabular-nums font-bold text-ink-900">
                {money(total, invoice.currency)}
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>

      {/* An unpriced line makes the total a partial figure, and a total that
          silently omits an item is the one number nobody may misread. */}
      {unpriced ? (
        <p className="mt-2 text-xs font-medium text-ink-700">
          One or more items have no price. The total above covers only the priced items.
        </p>
      ) : null}

      {invoice.terms ? (
        <div className="mt-6">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Terms and conditions</p>
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink-800">{invoice.terms}</p>
        </div>
      ) : null}

      <div className="mt-8 flex items-end justify-between border-t border-ink-300 pt-3">
        <p className="text-xs text-ink-500">
          Proforma invoice — not a tax invoice. Values are an estimate for customs and
          payment arrangement.
        </p>
        <div className="text-right">
          <div className="mb-1 h-10 w-44 border-b border-ink-400" />
          <p className="text-xs text-ink-500">Authorised signature</p>
        </div>
      </div>
    </div>
  );
}
