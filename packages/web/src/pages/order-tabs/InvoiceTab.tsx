/**
 * Step 18 — Invoice.
 *
 * The last sheet in the workbook's menu, and the last thing that happens to an
 * order: it ships, and it is invoiced.
 *
 * The two are one screen because in this factory they are one act — the AWB or
 * container number and the invoice go out together, and the shipment's own
 * quantity and date are what the invoice is for. The shipment records reuse the
 * existing `Shipment` model and the existing shipping screen underneath rather
 * than a second parallel one.
 *
 * The invoice total is derived from the shipped quantity and the order's unit
 * price, and it says "Not calculated" when either is missing. A confident
 * number on a customer's invoice that nobody agreed is worse than a blank.
 */

import { useQuery } from '@tanstack/react-query';
import { FileText, Lock, Send, Truck } from 'lucide-react';
import { fmtDate, type OrderDetailDto } from '@opsflow/shared';
import { api } from '../../lib/api';
import { Card, CardHeader, Num, EmptyState, Spinner, clsx } from '../../components/ui';
import { PackingTab } from './PackingTab';

export function InvoiceTab({ order }: { order: OrderDetailDto }) {
  const { data: proformaRes, isLoading } = useQuery({
    queryKey: ['proforma', order.id],
    queryFn: () => api.steps.proforma(order.id),
  });

  // Shipments come from their own endpoint, the same one the shipping screen
  // below already uses — so both read one source rather than two.
  const { data: shipmentRes } = useQuery({
    queryKey: ['shipments', order.id],
    queryFn: () => api.packing.shipments(order.id),
  });

  if (isLoading) return <Spinner label="Loading the invoice…" />;

  const proforma = proformaRes?.data ?? null;
  const shipped = order.funnel.find((f) => f.ledger === 'SHIPPED')?.qty ?? 0;
  const price = order.pricePerPieceUsd;

  // Both or neither. A total from a quantity with no price is a guess.
  const invoiceTotal = shipped > 0 && price != null ? shipped * price : null;

  const shipment = (shipmentRes?.data ?? [])[0] ?? null;
  const hasShipped = Boolean(shipment?.actualShippingDate);

  return (
    <div className="space-y-4 p-5">
      {/* ── The invoice ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Invoice"
          subtitle="What the customer is billed, and for what"
        />
        <div className="grid grid-cols-2 gap-px bg-ink-200 sm:grid-cols-4">
          <Fact
            label="Invoice number"
            value={proforma?.number ?? 'Not issued'}
            muted={!proforma?.number}
          />
          <Fact
            label="Status"
            value={
              !proforma ? 'No invoice yet'
              : proforma.sentAt ? 'Sent to customer'
              : 'Draft'
            }
            muted={!proforma}
          />
          <Fact label="Shipped quantity" value={<Num value={shipped} suffix=" pcs" />} />
          <Fact
            label="Unit price"
            value={<Num value={price} kind="money" places={2} fallback="Not set" />}
          />
        </div>

        <div className="border-t border-ink-100 px-4 py-3.5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-ink-700">Invoice value</span>
            <span className="tnum text-2xl font-semibold text-ink-900">
              <Num value={invoiceTotal} kind="money" places={2} />
            </span>
          </div>
          {invoiceTotal == null && (
            <p className="mt-1 text-xs text-ink-500">
              {shipped === 0
                ? 'Nothing has shipped yet, so there is nothing to invoice.'
                : 'No unit price is set on the order, so the value cannot be worked out. Set it on the Order Details step.'}
            </p>
          )}
          {invoiceTotal != null && (
            <p className="mt-1 text-xs text-ink-500">
              {shipped.toLocaleString()} pieces × ${price!.toFixed(2)} — from what actually shipped,
              not from what was ordered.
            </p>
          )}
        </div>

        {proforma && (
          <div className="flex items-start gap-2 border-t border-ink-100 bg-ink-50 px-4 py-3">
            {proforma.sentAt ? <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
              : <FileText className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />}
            <div className="text-xs text-ink-600">
              <p>
                <strong>Proforma invoice {proforma.number ?? '(unnumbered)'}</strong>
                {proforma.sentAt
                  ? <> was sent to the customer on {fmtDate(proforma.sentAt)}.</>
                  : <> is still a draft.</>}
                {proforma.grandTotal != null && (
                  <> Quoted value: {proforma.currency} {proforma.grandTotal.toLocaleString('en-GB', { minimumFractionDigits: 2 })}.</>
                )}
              </p>
              {proforma.grandTotal != null && invoiceTotal != null
                && Math.abs(proforma.grandTotal - invoiceTotal) > 0.01 && (
                <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900">
                  The invoice value differs from the quotation by{' '}
                  {Math.abs(proforma.grandTotal - invoiceTotal).toLocaleString('en-GB', { minimumFractionDigits: 2 })}.
                  That is normal when the shipped quantity differs from the ordered one — worth
                  checking the customer expects it.
                </p>
              )}
              <p className="mt-1">Edit it on step 4, Proforma Invoice.</p>
            </div>
          </div>
        )}
      </Card>

      {/* ── The shipment ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Shipment" subtitle="What left the factory, and when" />
        {!shipment ? (
          <EmptyState
            title="No shipment booked"
            detail="Book the shipment below. An invoice is issued for what actually shipped, so this comes first."
          />
        ) : (
          <div className="grid grid-cols-2 gap-px bg-ink-200 sm:grid-cols-4">
            <Fact label="Method" value={shipment.method ?? 'Not set'} muted={!shipment.method} />
            <Fact
              label="Status"
              value={
                <span className={clsx(
                  'chip',
                  hasShipped ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                    : 'bg-amber-50 text-amber-800 ring-amber-600/20',
                )}>
                  {shipment.status.replace(/_/g, ' ')}
                </span>
              }
            />
            <Fact
              label="Shipped on"
              value={shipment.actualShippingDate ? fmtDate(shipment.actualShippingDate) : 'Not yet'}
              muted={!shipment.actualShippingDate}
            />
            <Fact
              label="Tracking"
              value={shipment.trackingNumber ?? shipment.carrier ?? 'Not set'}
              muted={!shipment.trackingNumber && !shipment.carrier}
            />
          </div>
        )}
        <p className="flex items-start gap-2 border-t border-ink-100 bg-ink-50 px-4 py-2 text-2xs text-ink-500">
          <Truck className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            The shipment and the invoice are one act in this factory: the paperwork goes with the
            goods. Book it below and the figures above follow.
          </span>
        </p>
      </Card>

      {/* The existing shipping screen, reused rather than rebuilt. */}
      <div className="-mx-5 -mb-5">
        <PackingTab order={order} focus="shipping" />
      </div>

      <p className="flex items-center gap-1.5 px-1 text-2xs text-ink-400">
        <Send className="h-3 w-3" />
        OpsFlow records the invoice; it does not send it. Send it however you normally do.
      </p>
    </div>
  );
}

function Fact({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className={clsx('mt-0.5 text-sm font-semibold', muted ? 'italic text-ink-400' : 'text-ink-900')}>
        {value}
      </p>
    </div>
  );
}
