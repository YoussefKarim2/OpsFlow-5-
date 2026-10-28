/**
 * The invoice or proforma as a document.
 *
 * One rendering for the screen and for paper. On screen it is the preview
 * beside the editor; when the browser prints, the stylesheet hides the
 * application and this sheet becomes the page. There is no second template,
 * so what the person sees is what the customer gets.
 *
 * It reads a stored document and nothing else. The letterhead is the company
 * profile as it was when the document was built; a blank in the profile is a
 * blank on the page rather than an invented address. Totals are recomputed
 * from the lines by the same shared arithmetic the API uses.
 *
 * Laid out the way the factory's suppliers lay theirs out — cover note, the
 * invoice itself, shipped against ordered, then the packing list — because
 * that is the document the office already knows how to read.
 */

import { ProformaSheetDocument } from './ProformaSheetDocument';
import { amountInWords, computeInvoiceTotals, fmtDate, fmtMoney, InvoiceKind, InvoiceLineKind, InvoiceStatus, summariseGoods, type InvoiceDto } from '@opsflow/shared';
import { clsx } from './ui';

const money = (n: number | null | undefined) => (n == null ? '—' : fmtMoney(n, '', 2));
/** A rate prints every decimal it was agreed at — 7.2535 is not 7.25 — and at least the two of a price. */
const rate = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const qty = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));
const kg = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 3 }));

/** Free text that may be Arabic: the browser picks the direction per element. */
function T({ children, className }: { children: string | null | undefined; className?: string }) {
  if (!children) return null;
  return <span dir="auto" className={clsx('whitespace-pre-line', className)}>{children}</span>;
}

function SectionLabel({ children }: { children: string }) {
  return <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-500">{children}</p>;
}

/** The distinct values, in order, as one printed line: split POs usually share a name and style. */
const joined = (values: Array<string | null>): string =>
  [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))].join(', ');

export function InvoiceDocument({ doc }: { doc: InvoiceDto }) {
  // The factory's own proforma layout is a document of its own.
  if (doc.lineLayout === 'SHEET') return <ProformaSheetDocument doc={doc} />;
  return <StandardDocument doc={doc} />;
}

function StandardDocument({ doc }: { doc: InvoiceDto }) {
  const totals = computeInvoiceTotals(doc.lines);
  const goods = doc.lines.filter((l) => l.kind === InvoiceLineKind.ITEM);
  const extras = doc.lines.filter((l) => l.kind === InvoiceLineKind.EXTRA);
  const isInvoice = doc.kind === InvoiceKind.INVOICE;
  // Every order the document covers; a JSON saved before documents could
  // cover several orders has only the one.
  const orders = doc.orders?.length ? doc.orders : [doc.order];
  // "Total only": one line per style (or order), its pieces, rate and amount. The lines
  // themselves and every total below are the same as the detailed listing.
  const summary = doc.lineLayout === 'SUMMARY' ? summariseGoods(doc.lines, orders) : null;
  const title = isInvoice ? 'INVOICE' : 'PROFORMA INVOICE';
  const seller = doc.seller;
  const sellerLine = [seller.address, seller.taxId ? `Tax ID: ${seller.taxId}` : null, seller.email, seller.website]
    .filter(Boolean).join('  ·  ');
  const termLines = (doc.terms ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const watermark = doc.status === InvoiceStatus.VOID ? 'VOID' : doc.status === InvoiceStatus.DRAFT ? 'DRAFT' : null;
  const initials = seller.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="invoice-sheet print-document relative mx-auto w-full max-w-[210mm] rounded-lg border border-ink-200 bg-white p-8 text-[11px] leading-snug text-ink-900 shadow-card print:text-[10.5pt]">
      {watermark && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
          <span className={clsx('select-none -rotate-[28deg] text-[120px] font-black tracking-[0.3em] opacity-[0.07]', watermark === 'VOID' ? 'text-red-700' : 'text-ink-900')}>
            {watermark}
          </span>
        </div>
      )}

      {/* ── Cover note ─────────────────────────────────────────────────── */}
      {doc.coverNote && (
        <section className="avoid-break mb-6">
          <div className="whitespace-pre-line text-[11.5px] leading-relaxed text-ink-800">
            <T>{doc.coverNote}</T>
          </div>
          {doc.customerReference && (
            <p className="mt-2 text-[11px]"><span className="font-semibold">Your reference:</span> <T>{doc.customerReference}</T></p>
          )}
        </section>
      )}

      {/* ── The invoice ────────────────────────────────────────────────── */}
      <section>
        <SectionLabel>{title}</SectionLabel>
        <div className="overflow-hidden rounded border border-ink-200">
          <div className="flex items-start justify-between gap-4 bg-[#1f2328] px-5 pb-3 pt-4 text-white">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded bg-white/10 text-sm font-black tracking-wide">
                {initials}
              </div>
              <div>
                <p className="text-lg font-black uppercase leading-tight tracking-wide">{seller.name}</p>
                {seller.tagline && <p className="text-[10px] uppercase tracking-widest text-white/60">{seller.tagline}</p>}
              </div>
            </div>
            <div className="text-right">
              <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-white/60">{title}</p>
              <p className="font-mono text-xl font-bold tracking-wide text-orange-400">{doc.number}</p>
            </div>
          </div>
          {sellerLine && (
            <div className="bg-[#2a2f36] px-5 py-1.5 text-[9.5px] text-white/75">
              {seller.name}{seller.tagline ? ` · ${seller.tagline}` : ''}
              <br />
              {sellerLine}
            </div>
          )}

          {/* Bill to + meta */}
          <div className="grid grid-cols-2 gap-6 px-5 pb-4 pt-4">
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-500">Bill to</p>
              <p className="mt-1 text-[13px] font-bold"><T>{doc.billTo}</T></p>
              {doc.billToAddress && <p className="mt-0.5 text-ink-700"><T>{doc.billToAddress}</T></p>}
              {doc.billToEmail && <p className="mt-0.5 text-ink-700">{doc.billToEmail}</p>}
            </div>
            <table className="ml-auto w-auto text-right">
              <tbody>
                <Meta label={isInvoice ? 'Invoice date' : 'Date'} value={fmtDate(doc.date)} />
                {doc.paymentTerms && <Meta label="Terms" value={doc.paymentTerms} />}
                {doc.dueDate && <Meta label={isInvoice ? 'Due date' : 'Valid until'} value={fmtDate(doc.dueDate)} />}
                <Meta label="P.O. #" value={joined(orders.map((o) => o.poNumber))} />
                <Meta label="Order" value={joined(orders.map((o) => o.orderName))} />
                {joined(orders.map((o) => o.styleNumber)) && <Meta label="Style" value={joined(orders.map((o) => o.styleNumber))} />}
                {isInvoice && (doc.shipmentRef || doc.shippedOn) && (
                  <Meta label="Shipment" value={[doc.shipmentRef, doc.shippedOn ? fmtDate(doc.shippedOn) : null].filter(Boolean).join(' · ')} />
                )}
                {!isInvoice && doc.shippedOn && <Meta label="Shipping" value={fmtDate(doc.shippedOn)} />}
              </tbody>
            </table>
          </div>

          {/* Lines */}
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-[#1f2328] text-left text-[9.5px] font-semibold uppercase tracking-wider text-white">
                <th className="w-7 px-3 py-2">#</th>
                <th className="whitespace-nowrap px-2 py-2">Item &amp; description</th>
                {!summary && <th className="w-28 px-2 py-2">Size</th>}
                <th className="w-16 px-2 py-2 text-right">Qty</th>
                <th className="w-20 px-2 py-2 text-right">Rate</th>
                <th className="w-24 px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {goods.length === 0 && (
                <tr><td colSpan={summary ? 5 : 6} className="px-3 py-4 text-center italic text-ink-400">No goods lines.</td></tr>
              )}
              {summary?.map((l, i) => (
                <tr key={i} className="border-b border-ink-200 align-top">
                  <td className="px-3 py-2 text-ink-500">{i + 1}</td>
                  <td className="px-2 py-2 font-semibold"><T>{l.description}</T></td>
                  <td className="tnum px-2 py-2 text-right">{qty(l.quantity)}</td>
                  <td className="tnum px-2 py-2 text-right" title={l.mixedRates ? 'Average rate: the lines of this row carry different rates' : undefined}>
                    {rate(l.unitPrice)}{l.mixedRates && <span className="text-ink-400"> avg</span>}
                  </td>
                  <td className="tnum px-3 py-2 text-right font-medium">{money(l.lineTotal)}</td>
                </tr>
              ))}
              {!summary && goods.map((l, i) => (
                <tr key={l.id || i} className="border-b border-ink-200 align-top">
                  <td className="px-3 py-2 text-ink-500">{i + 1}</td>
                  <td className="px-2 py-2 font-semibold"><T>{l.description}</T></td>
                  <td className="px-2 py-2 text-ink-700"><T>{l.size ?? '—'}</T></td>
                  <td className="tnum px-2 py-2 text-right">{qty(l.quantity)}</td>
                  <td className="tnum px-2 py-2 text-right">{rate(l.unitPrice)}</td>
                  <td className="tnum px-3 py-2 text-right font-medium">{money(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="avoid-break flex justify-end px-5 pb-4 pt-3">
            <table className="w-64 text-right">
              <tbody>
                <tr className="border-b border-ink-200">
                  <td className="py-1 text-left font-semibold text-ink-600">Subtotal</td>
                  <td className="tnum py-1">{money(totals.subtotal)}</td>
                </tr>
                {extras.map((l, i) => (
                  <tr key={l.id || `x${i}`} className="border-b border-ink-200">
                    <td className="py-1 text-left font-semibold text-ink-600"><T>{l.description}</T></td>
                    <td className="tnum py-1">{money(l.lineTotal)}</td>
                  </tr>
                ))}
                <tr className="border-b-2 border-ink-900">
                  <td className="py-1.5 text-left text-[13px] font-bold">Total</td>
                  <td className="tnum py-1.5 text-[13px] font-bold">$ {money(totals.total)}</td>
                </tr>
                <tr className="bg-ink-50">
                  <td className="py-1 text-left font-semibold">Balance due</td>
                  <td className="tnum py-1 font-semibold">$ {money(totals.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="px-5 pb-4">
            <p>
              <span className="text-ink-600">Total in words: </span>
              <span className="font-semibold italic">{amountInWords(totals.total)}</span>
            </p>
            {totals.incomplete && (
              <p className="mt-1 text-[10px] font-medium text-amber-800">
                One or more goods lines have no rate yet. The totals above cover only the priced lines.
              </p>
            )}
          </div>

          {(termLines.length > 0 || doc.bankDetails) && (
            <div className="avoid-break mx-5 mb-4 grid grid-cols-2 gap-3">
              <div className="rounded border border-ink-200 p-3">
                <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-500">Terms &amp; conditions</p>
                {termLines.length === 0
                  ? <p className="italic text-ink-400">—</p>
                  : <ul className="list-disc space-y-0.5 pl-4 text-ink-800">{termLines.map((t, i) => <li key={i}><T>{t}</T></li>)}</ul>}
              </div>
              <div className="rounded border border-ink-200 p-3">
                <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-500">Payment details</p>
                {doc.bankDetails
                  ? <pre className="whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-ink-800">{doc.bankDetails}</pre>
                  : <p className="italic text-ink-400">—</p>}
              </div>
            </div>
          )}

          {sellerLine && (
            <p className="border-t border-ink-100 px-5 py-2 text-center text-[9px] text-ink-500">
              {seller.name} · {sellerLine}
            </p>
          )}
        </div>
      </section>

      {doc.notes && (
        <section className="avoid-break mt-5">
          <SectionLabel>Notes</SectionLabel>
          <p className="text-ink-800"><T>{doc.notes}</T></p>
        </section>
      )}

      {/* ── Shipped vs ordered ─────────────────────────────────────────── */}
      {isInvoice && doc.reconciliation.length > 0 && (
        <section className="mt-6">
          <SectionLabel>Shipped vs ordered</SectionLabel>
          <p className="mb-2 flex gap-3 text-[9.5px] text-ink-500">
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-red-500" />Short</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-500" />Over-shipped</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500" />Balanced</span>
          </p>
          {doc.reconciliation.map((g) => (
            <div key={`${g.poNumber ?? doc.order.poNumber}|${g.product}`} className="avoid-break mb-3">
              <p className="mb-1 font-bold"><T>{g.product}</T> <span className="font-normal text-ink-500">({g.poNumber ?? doc.order.poNumber})</span></p>
              <table className="w-auto min-w-[50%] border-collapse border border-ink-200">
                <thead>
                  <tr className="bg-ink-50 text-[9.5px] font-semibold uppercase tracking-wider text-ink-600">
                    <th className="border border-ink-200 px-3 py-1 text-left">Size</th>
                    <th className="border border-ink-200 px-3 py-1 text-right">Ordered</th>
                    <th className="border border-ink-200 px-3 py-1 text-right">Shipped</th>
                    <th className="border border-ink-200 px-3 py-1 text-right">Short</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.label}>
                      <td className="border border-ink-200 px-3 py-1 font-medium"><T>{r.label}</T></td>
                      <td className="tnum border border-ink-200 px-3 py-1 text-right">{qty(r.ordered)}</td>
                      <td className="tnum border border-ink-200 px-3 py-1 text-right">{qty(r.shipped)}</td>
                      <td className={clsx('tnum border border-ink-200 px-3 py-1 text-right font-semibold',
                        r.short > 0 ? 'text-red-600' : r.short < 0 ? 'text-amber-600' : 'text-emerald-600')}>
                        {r.short < 0 ? `+${qty(-r.short)}` : qty(r.short)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[9.5px] text-ink-500">
                Ordered: {qty(g.ordered)} · Shipped: {qty(g.shipped)} · Short: {g.short < 0 ? `over by ${qty(-g.short)}` : qty(g.short)}
              </p>
            </div>
          ))}
          {(() => {
            // Shortages and over-shipments are added up apart, size by size, so
            // extra pieces of one size, colour or PO never hide a shortage of another.
            const rows = doc.reconciliation.flatMap((g) => g.rows);
            const short = rows.reduce((a, r) => a + Math.max(0, r.short), 0);
            const over = rows.reduce((a, r) => a + Math.max(0, -r.short), 0);
            return (
              <p className="font-bold">
                Grand total — Ordered: {qty(doc.reconciliation.reduce((a, g) => a + g.ordered, 0))} ·
                Shipped: {qty(doc.reconciliation.reduce((a, g) => a + g.shipped, 0))} ·
                Short: {qty(short)}{over > 0 ? <> · Over-shipped: {qty(over)}</> : null}
              </p>
            );
          })()}
        </section>
      )}

      {/* ── Packing list / manifest ────────────────────────────────────── */}
      {doc.manifest.length > 0 && (
        <section className="mt-6">
          <SectionLabel>{isInvoice ? 'Packing list / manifest' : 'Packing list'}</SectionLabel>
          <table className="mb-2 text-[11px]">
            <tbody>
              {isInvoice && <tr><td className="pr-4 font-bold">Shipment No.</td><td>{doc.shipmentRef ?? '—'}</td></tr>}
              <tr><td className="pr-4 font-bold">Date</td><td>{doc.shippedOn ? fmtDate(doc.shippedOn) : fmtDate(doc.date)}</td></tr>
              {doc.customerReference && <tr><td className="pr-4 font-bold">Your reference(s)</td><td><T>{doc.customerReference}</T></td></tr>}
              <tr><td className="pr-4 font-bold">Consignee</td><td><T>{doc.billTo}</T></td></tr>
            </tbody>
          </table>
          <table className="w-full border-collapse border border-ink-200">
            <thead>
              <tr className="bg-ink-50 text-[9.5px] font-semibold uppercase tracking-wider text-ink-600">
                <th className="border border-ink-200 px-2 py-1 text-left">Carton<br /><span className="font-normal normal-case tracking-normal">of {doc.manifest.length}</span></th>
                <th className="border border-ink-200 px-2 py-1 text-left">Carton no.</th>
                <th className="border border-ink-200 px-2 py-1 text-left">Product</th>
                <th className="border border-ink-200 px-2 py-1 text-left">Contents</th>
                <th className="border border-ink-200 px-2 py-1 text-right">Pieces</th>
                <th className="border border-ink-200 px-2 py-1 text-right">Net<br /><span className="font-normal normal-case tracking-normal">kg</span></th>
                <th className="border border-ink-200 px-2 py-1 text-right">Gross<br /><span className="font-normal normal-case tracking-normal">kg</span></th>
              </tr>
            </thead>
            <tbody>
              {doc.manifest.map((c) => (
                <tr key={c.n} className="align-top">
                  <td className="border border-ink-200 px-2 py-1.5"><span className="font-bold">{c.n}</span><br /><span className="text-ink-500">#{c.n}</span></td>
                  <td className="border border-ink-200 px-2 py-1.5 font-mono text-[10px]">{c.cartonNumber}{c.cartonSize ? <><br /><span className="font-sans text-ink-500">{c.cartonSize}</span></> : null}</td>
                  <td className="border border-ink-200 px-2 py-1.5"><span className="font-medium">{c.poNumber ?? doc.order.poNumber}</span><br /><span className="text-ink-600"><T>{c.product}</T></span></td>
                  <td className="border border-ink-200 px-2 py-1.5">
                    {c.contents.length > 0
                      ? c.contents.map((x, i) => <span key={i}>{i > 0 ? ', ' : ''}<T>{x.label}</T> × {qty(x.qty)}</span>)
                      : <T>{c.contentsText || '—'}</T>}
                  </td>
                  <td className="tnum border border-ink-200 px-2 py-1.5 text-right font-medium">{qty(c.pieces)}</td>
                  <td className="tnum border border-ink-200 px-2 py-1.5 text-right">{kg(c.netKg)}</td>
                  <td className="tnum border border-ink-200 px-2 py-1.5 text-right">{kg(c.grossKg)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-ink-50 font-bold">
                <td colSpan={4} className="border border-ink-200 px-2 py-1.5">Grand total — {doc.manifest.length} carton{doc.manifest.length === 1 ? '' : 's'}</td>
                <td className="tnum border border-ink-200 px-2 py-1.5 text-right">{qty(doc.manifest.reduce((a, c) => a + c.pieces, 0))}</td>
                <td className="tnum border border-ink-200 px-2 py-1.5 text-right">{kg(sumOrNull(doc.manifest.map((c) => c.netKg)))}</td>
                <td className="tnum border border-ink-200 px-2 py-1.5 text-right">{kg(sumOrNull(doc.manifest.map((c) => c.grossKg)))}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      <p className="mt-6 border-t border-ink-100 pt-2 text-center text-[9px] text-ink-500">
        If anything looks wrong, just reply to this email.
        {sellerLine ? <><br />{seller.name} · {sellerLine}</> : null}
      </p>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="whitespace-nowrap pr-4 align-top text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</td>
      <td className="font-semibold"><T>{value}</T></td>
    </tr>
  );
}

/** A sum of weights, or nothing when none was recorded: a "0 kg" shipment is not a fact anyone measured. */
function sumOrNull(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v != null);
  return known.length === 0 ? null : Math.round(known.reduce((a, b) => a + b, 0) * 1000) / 1000;
}
