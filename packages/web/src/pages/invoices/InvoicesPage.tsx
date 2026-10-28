/**
 * Proforma / Invoice — the section in the sidebar.
 *
 * Three things on one screen: every document the factory has raised, the
 * orders that could be invoiced now, and the letterhead the documents are
 * printed with. "New document" builds a draft from one order, or from several
 * POs of the same customer (an order split into several POs is invoiced on one
 * document), in one step; the draft opens in the editor beside its preview.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, Check, FileText, Plus, Receipt, Search, Send, X } from 'lucide-react';
import {
  fmtDate, INVOICE_KIND_LABEL, InvoiceKind, InvoiceStatus,
  type CompanyProfileDto, type InvoiceCandidateDto, type InvoiceListRowDto, type OrderSummaryDto,
} from '@opsflow/shared';
import { InvoiceStatusChip } from '../../components/InvoiceStatusChip';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, EmptyState, ErrorNote, Field, Modal, Num, Spinner, StatTile, clsx, useDebounced, useToast,
} from '../../components/ui';
import { ComboSelect } from '../../components/ComboSelect';

type KindFilter = '' | InvoiceKind;
type Picked = { orderId: string; poNumber: string; orderName: string; clientId: string; clientName: string };
type StatusFilter = '' | InvoiceStatus;

export function InvoicesPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [kind, setKind] = useState<KindFilter>('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const [creating, setCreating] = useState<{ open: boolean; order?: Picked | null; kind?: InvoiceKind }>({ open: false });
  const [params, setParams] = useSearchParams();
  const newFor = params.get('new');

  // Arriving from an order's Invoice step: open the dialog on that order.
  const presetOrder = useQuery({
    queryKey: ['invoice-sources', newFor],
    queryFn: () => api.invoices.sources(newFor!),
    enabled: !!newFor,
  });
  useEffect(() => {
    if (!newFor || !presetOrder.data) return;
    const o = presetOrder.data.data;
    setCreating({ open: true, order: { orderId: o.orderId, poNumber: o.poNumber, orderName: o.orderName, clientId: o.clientId, clientName: o.clientName } });
    setParams({}, { replace: true });
  }, [newFor, presetOrder.data, setParams]);

  // One request for every document; the filters and the tiles are both read
  // from it, so they cannot disagree and a filter change costs no round trip.
  const list = useQuery({ queryKey: ['invoices', 'all'], queryFn: () => api.invoices.list() });
  const candidates = useQuery({ queryKey: ['invoice-candidates'], queryFn: api.invoices.candidates, staleTime: 60_000 });

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data?.data ?? []).filter((r) =>
      (!kind || r.kind === kind)
      && (!status || r.status === status)
      && (!needle || [r.number, r.billTo, r.clientName, ...r.orders.flatMap((o) => [o.poNumber, o.orderName])].some((v) => v.toLowerCase().includes(needle))));
  }, [list.data, kind, status, q]);
  const stats = useMemo(() => {
    const docs = list.data?.data ?? [];
    const now = new Date();
    const thisMonth = (d: string) => { const x = new Date(d); return x.getUTCFullYear() === now.getUTCFullYear() && x.getUTCMonth() === now.getUTCMonth(); };
    const issuedInvoices = docs.filter((d) => d.kind === 'INVOICE' && d.status === 'ISSUED');
    return {
      drafts: docs.filter((d) => d.status === 'DRAFT').length,
      awaitingSend: docs.filter((d) => d.status === 'ISSUED' && !d.sentAt).length,
      issuedThisMonth: issuedInvoices.filter((d) => thisMonth(d.issuedAt ?? d.date)).reduce((a, d) => a + d.total, 0),
      issuedThisMonthCount: issuedInvoices.filter((d) => thisMonth(d.issuedAt ?? d.date)).length,
    };
  }, [list.data]);

  // Orders with more packed or shipped than their issued invoices cover — so a
  // split shipment stays on the list until its second invoice is issued.
  const ready = useMemo(() => (candidates.data?.data ?? []).filter((c) => {
    const invoiced = c.invoices.filter((i) => i.kind === 'INVOICE' && i.status === 'ISSUED').reduce((a, i) => a + i.totalQty, 0);
    return Math.max(c.packedQty, c.shippedQty) > invoiced;
  }), [candidates.data]);

  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Proforma / Invoice</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Every document is built from its order — the customer, the PO, the price, the cartons — and kept as the record once issued.
          </p>
        </div>
        {can('invoice:write') && (
          <button className="btn-primary" onClick={() => setCreating({ open: true })}>
            <Plus className="h-4 w-4" /> New document
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Ready to invoice" tone={ready.length > 0 ? 'accent' : 'neutral'} value={ready.length}
          sub={ready.length > 0 ? 'Orders packed or shipped with no issued invoice' : 'Every packed order has its invoice'} icon={<Receipt className="h-4 w-4" />} />
        <StatTile label="Drafts" value={stats.drafts} sub="Built, not yet issued" onClick={() => setStatus('DRAFT')} icon={<FileText className="h-4 w-4" />} />
        <StatTile label="Issued, not sent" tone={stats.awaitingSend > 0 ? 'amber' : 'neutral'} value={stats.awaitingSend}
          sub="Issued documents nobody has marked as sent" onClick={() => setStatus('ISSUED')} icon={<Send className="h-4 w-4" />} />
        <StatTile label="Invoiced this month" value={<Num value={stats.issuedThisMonth} kind="money" places={0} />}
          sub={`${stats.issuedThisMonthCount} invoice${stats.issuedThisMonthCount === 1 ? '' : 's'} issued`} />
      </div>

      {ready.length > 0 && (
        <Card>
          <CardHeader title="Ready to invoice" subtitle="Orders with goods packed or shipped and no issued invoice. One click builds the draft from the packing list; add the customer's other POs in the dialog to put them on one invoice." />
          <div className="divide-y divide-ink-100">
            {ready.slice(0, 8).map((c) => (
              <div key={c.orderId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <Link to={`/orders/${c.orderId}`} className="font-mono text-xs font-semibold text-accent-700 hover:underline">{c.poNumber}</Link>
                  <span className="ml-2 text-sm text-ink-800" dir="auto">{c.orderName}</span>
                  <span className="ml-2 text-xs text-ink-500">{c.clientName}</span>
                </div>
                <div className="flex gap-4 text-xs text-ink-600">
                  <span>Ordered <b className="tnum">{c.orderQty.toLocaleString()}</b></span>
                  <span>Packed <b className="tnum">{c.packedQty.toLocaleString()}</b></span>
                  <span>Shipped <b className="tnum">{c.shippedQty.toLocaleString()}</b></span>
                  <span>Price {c.pricePerPieceUsd == null ? <i className="text-amber-700">not set</i> : <b className="tnum">${c.pricePerPieceUsd.toFixed(2)}</b>}</span>
                </div>
                {c.invoices.some((i) => i.status === 'ISSUED' && i.kind === 'INVOICE') && (
                  <span className="text-2xs text-ink-500">Invoiced so far: {c.invoices.filter((i) => i.status === 'ISSUED' && i.kind === 'INVOICE').reduce((a, i) => a + i.totalQty, 0).toLocaleString()} pcs</span>
                )}
                {c.invoices.some((i) => i.status === 'DRAFT' && i.kind === 'INVOICE') ? (
                  <Link to={`/invoices/${c.invoices.find((i) => i.status === 'DRAFT' && i.kind === 'INVOICE')!.id}`} className="btn-secondary btn-sm">Open draft</Link>
                ) : can('invoice:write') ? (
                  <button className="btn-primary btn-sm" onClick={() => setCreating({ open: true, order: { orderId: c.orderId, poNumber: c.poNumber, orderName: c.orderName, clientId: c.clientId, clientName: c.clientName }, kind: 'INVOICE' })}>Build invoice</button>
                ) : null}
              </div>
            ))}
            {ready.length > 8 && <p className="px-4 py-2 text-xs text-ink-500">And {ready.length - 8} more — use New document to pick one.</p>}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Documents"
          subtitle={list.data ? `${rows.length} of ${list.data.data.length}${list.data.data.length >= 500 ? ' (newest 500)' : ''}` : undefined}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-md border border-ink-300 p-0.5">
                {([['', 'All'], ['INVOICE', 'Invoices'], ['PROFORMA', 'Proformas']] as Array<[KindFilter, string]>).map(([k, l]) => (
                  <button key={k} onClick={() => setKind(k)} className={clsx('rounded px-2 py-0.5 text-xs', kind === k ? 'bg-accent-600 text-white' : 'text-ink-600')}>{l}</button>
                ))}
              </div>
              <ComboSelect className="input !w-auto !py-1 text-xs" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                <option value="">Any status</option>
                <option value="DRAFT">Draft</option>
                <option value="ISSUED">Issued</option>
                <option value="VOID">Void</option>
              </ComboSelect>
              <label className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Number, PO, customer" className="input !w-52 !py-1 !pl-7 text-xs" />
              </label>
            </div>
          }
        />
        {list.isLoading ? <Spinner label="Loading documents…" />
          : list.error ? <div className="p-4"><ErrorNote error={list.error} onRetry={list.refetch} /></div>
          : rows.length === 0 ? (
            <EmptyState
              title={q || kind || status ? 'No documents match' : 'No documents yet'}
              detail={q || kind || status ? undefined : 'Press New document, pick an order, and the draft is built from it.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-ink-200 bg-ink-50">
                  <tr>
                    <th className="th">Number</th>
                    <th className="th">Status</th>
                    <th className="th">Date</th>
                    <th className="th">Customer</th>
                    <th className="th">PO / Order</th>
                    <th className="th text-right">Pieces</th>
                    <th className="th text-right">Total</th>
                    <th className="th">Sent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {rows.map((r) => <Row key={r.id} r={r} onOpen={() => navigate(`/invoices/${r.id}`)} />)}
                </tbody>
              </table>
            </div>
          )}
      </Card>

      <CompanyPanel />

      {creating.open && (
        <NewDocumentDialog
          preset={creating.order ?? null}
          presetKind={creating.kind}
          candidates={candidates.data?.data ?? []}
          onClose={() => setCreating({ open: false })}
        />
      )}
    </div>
  );
}

function Row({ r, onOpen }: { r: InvoiceListRowDto; onOpen: () => void }) {
  return (
    <tr onClick={onOpen} className="cursor-pointer hover:bg-accent-50/40">
      <td className="td">
        <p className="font-mono text-xs font-semibold text-accent-700">{r.number}</p>
        <p className="text-2xs text-ink-500">{INVOICE_KIND_LABEL[r.kind]}</p>
      </td>
      <td className="td"><InvoiceStatusChip status={r.status} sentAt={r.sentAt} /></td>
      <td className="td text-xs">{fmtDate(r.date)}</td>
      <td className="td text-xs" dir="auto">{r.billTo}</td>
      <td className="td">
        <p className="max-w-[16rem] truncate font-mono text-xs text-ink-700" title={r.orders.map((o) => o.poNumber).join(', ')}>{r.orders.map((o) => o.poNumber).join(', ')}</p>
        <p className="max-w-[16rem] truncate text-xs text-ink-500" dir="auto">
          {[...new Set(r.orders.map((o) => o.orderName))].join(', ')}
          {r.orders.length > 1 && <span className="ml-1 text-2xs text-ink-400">· {r.orders.length} orders</span>}
        </p>
      </td>
      <td className="td tnum text-right">{r.totalQty.toLocaleString()}</td>
      <td className={clsx('td tnum text-right font-medium', r.incomplete && 'text-amber-700')} title={r.incomplete ? 'A goods line has no rate yet' : undefined}>
        <Num value={r.total} kind="money" />{r.incomplete ? '*' : ''}
      </td>
      <td className="td text-xs text-ink-500">{r.sentAt ? fmtDate(r.sentAt) : r.status === 'ISSUED' ? <i>not yet</i> : '—'}</td>
    </tr>
  );
}

// ── New document ─────────────────────────────────────────────────────────────

type SourceChoice = { packingListId: string | null; shipmentId: string | null };

function NewDocumentDialog({ preset, presetKind, candidates, onClose }: {
  preset: Picked | null;
  presetKind?: InvoiceKind;
  candidates: InvoiceCandidateDto[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [kind, setKind] = useState<InvoiceKind>(presetKind ?? 'INVOICE');
  // An order split into several POs goes on one document, so the dialog
  // collects orders rather than picking one. All of them must be billed to
  // the same customer; the server checks that too.
  const [picked, setPicked] = useState<Picked[]>(preset ? [preset] : []);
  const [choices, setChoices] = useState<Record<string, SourceChoice>>({});
  const [term, setTerm] = useState('');
  const q = useDebounced(term, 250);

  const found = useQuery({ queryKey: ['search', q], queryFn: () => api.orders.search(q), enabled: q.trim().length >= 2 });

  // Matched by id: two customers can share a name.
  const customerId = picked[0]?.clientId ?? null;
  const customer = picked[0]?.clientName ?? null;
  const pickedIds = new Set(picked.map((p) => p.orderId));
  const add = (o: Picked) => { if (!pickedIds.has(o.orderId)) setPicked([...picked, o]); setTerm(''); };
  const remove = (id: string) => {
    setPicked(picked.filter((p) => p.orderId !== id));
    setChoices((c) => { const { [id]: _gone, ...rest } = c; return rest; });
  };
  const setChoice = (id: string, patch: Partial<SourceChoice>) =>
    setChoices((c) => ({ ...c, [id]: { ...(c[id] ?? { packingListId: null, shipmentId: null }), ...patch } }));

  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.invoices.create({
      kind,
      orders: picked.map((p) => ({ orderId: p.orderId, packingListId: choices[p.orderId]?.packingListId ?? null, shipmentId: choices[p.orderId]?.shipmentId ?? null })),
    }),
    onSuccess: (res) => {
      toast.success(`${res.data.number} built from PO ${res.data.orders.map((o) => o.poNumber).join(', ')}`);
      // Otherwise "Ready to invoice" still offers these orders for a minute.
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['invoice-candidates'] });
      onClose();
      navigate(`/invoices/${res.data.id}`);
    },
    onError: (e) => toast.error(e),
  });

  const searching = term.trim().length >= 2;
  // With an order picked, the suggestions are the same customer's other
  // orders that are packed or shipped — the usual other half of a split.
  const suggestions = searching ? [] : candidates
    .filter((c) => !pickedIds.has(c.orderId) && (!customerId || c.clientId === customerId))
    .slice(0, 6);
  const results: Array<Picked> = searching
    ? (found.data?.data ?? []).map((o: OrderSummaryDto) => ({ orderId: o.id, poNumber: o.poNumber, orderName: o.orderName, clientId: o.clientId, clientName: o.clientName }))
    : suggestions.map((c) => ({ orderId: c.orderId, poNumber: c.poNumber, orderName: c.orderName, clientId: c.clientId, clientName: c.clientName }));

  return (
    <Modal
      open
      onClose={onClose}
      title="New document"
      subtitle="Pick the order, or several POs of the same customer to put on one document; the draft is built from them and opens for review."
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={picked.length === 0 || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Building…' : `Build ${kind === 'INVOICE' ? 'invoice' : 'proforma'}${picked.length > 1 ? ` for ${picked.length} orders` : ''}`}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <span className="label">Document</span>
          <div className="grid grid-cols-2 gap-2">
            {(['INVOICE', 'PROFORMA'] as InvoiceKind[]).map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)}
                className={clsx('rounded-md border px-3 py-2 text-left text-sm', kind === k ? 'border-accent-500 bg-accent-50 text-accent-900' : 'border-ink-300 text-ink-700 hover:bg-ink-50')}>
                <p className="font-semibold">{INVOICE_KIND_LABEL[k]}</p>
                <p className="text-2xs text-ink-500">{k === 'INVOICE' ? 'For a shipment: priced on the cartons packed, with the manifest and shipped-vs-ordered.' : 'A quotation before anything is made: priced on the ordered quantities.'}</p>
              </button>
            ))}
          </div>
        </div>

        <Field
          label={picked.length > 1 ? `Orders (${picked.length})` : 'Orders'}
          hint={picked.length === 0
            ? 'Type a PO, order name or customer, or pick one of the orders ready to invoice. Add more POs to put them on the same document.'
            : `Add the other POs of ${customer} to put them on the same document. Each keeps its own lines, cartons and shipped-vs-ordered.`}
        >
          {picked.length > 0 && (
            <div className="mb-2 space-y-1">
              {picked.map((p) => (
                <div key={p.orderId} className="flex items-center gap-3 rounded-md border border-ink-300 bg-ink-50 px-3 py-2">
                  <span className="font-mono text-xs font-semibold text-accent-700">{p.poNumber}</span>
                  <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{p.orderName}</span>
                  <span className="text-xs text-ink-500">{p.clientName}</span>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => remove(p.orderId)} aria-label={`Remove PO ${p.poNumber}`}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <input autoFocus={picked.length === 0} className="input" value={term} onChange={(e) => setTerm(e.target.value)}
            placeholder={picked.length === 0 ? 'PO, order, customer…' : 'Add another PO…'} />
          {(searching || suggestions.length > 0 || picked.length === 0) && (
            <div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-ink-200">
              {!searching && suggestions.length > 0 && (
                <p className="bg-ink-50 px-3 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-500">
                  {customer ? `${customer}: other orders packed or shipped` : 'Packed or shipped'}
                </p>
              )}
              {results.length === 0 ? (
                <p className="px-3 py-3 text-center text-xs text-ink-500">{found.isFetching ? 'Searching…' : 'No orders match.'}</p>
              ) : results.map((o) => {
                const already = pickedIds.has(o.orderId);
                const otherCustomer = !!customerId && o.clientId !== customerId;
                return (
                  <button key={o.orderId} type="button" disabled={already || otherCustomer} onClick={() => add(o)}
                    title={otherCustomer ? `Billed to ${o.clientName}. One document is billed to one customer.` : undefined}
                    className="flex w-full items-center gap-3 border-b border-ink-100 px-3 py-2 text-left last:border-0 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent">
                    {already ? <Check className="h-3.5 w-3.5 text-accent-600" /> : <Plus className="h-3.5 w-3.5 text-ink-400" />}
                    <span className="font-mono text-xs font-semibold text-accent-700">{o.poNumber}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-800" dir="auto">{o.orderName}</span>
                    <span className="truncate text-xs text-ink-500">{otherCustomer ? `${o.clientName} · other customer` : o.clientName}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Field>

        {kind === 'INVOICE' && picked.map((p) => (
          <OrderSources key={p.orderId} order={p} showHeading={picked.length > 1}
            choice={choices[p.orderId] ?? { packingListId: null, shipmentId: null }}
            onChange={(patch) => setChoice(p.orderId, patch)} />
        ))}
      </div>
    </Modal>
  );
}

/** The packing list and consignment of one order on the new document. */
function OrderSources({ order, showHeading, choice, onChange }: {
  order: Picked;
  showHeading: boolean;
  choice: SourceChoice;
  onChange: (patch: Partial<SourceChoice>) => void;
}) {
  const sources = useQuery({ queryKey: ['invoice-sources', order.orderId], queryFn: () => api.invoices.sources(order.orderId) });
  const src = sources.data?.data;
  if (sources.isLoading) return <Spinner label={`Reading PO ${order.poNumber}'s packing lists and shipments…`} />;
  if (sources.error) return <ErrorNote error={sources.error} onRetry={sources.refetch} />;
  if (!src) return null;
  return (
    <div className={clsx(showHeading && 'rounded-md border border-ink-200 p-3')}>
      {showHeading && (
        <p className="mb-2 text-xs font-semibold text-ink-800">
          <span className="font-mono text-accent-700">PO {order.poNumber}</span> <span className="font-normal text-ink-500" dir="auto">{order.orderName}</span>
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className="label">Packing list</span>
          {src.packingLists.length === 0
            ? <p className="text-xs text-amber-800">No packing list on this order. The draft will be built from the shipment, or from the ordered quantities, and say so.</p>
            : (
              <div className="space-y-1">
                <Choice checked={choice.packingListId === null} onPick={() => onChange({ packingListId: null })} label="Choose for me" hint="The approved list with cartons, else the newest." />
                {src.packingLists.map((l) => (
                  <Choice key={l.id} checked={choice.packingListId === l.id} onPick={() => onChange({ packingListId: l.id })}
                    label={`${l.reference ?? 'Packing list'} — ${l.cartonCount} carton${l.cartonCount === 1 ? '' : 's'}, ${l.totalQty.toLocaleString()} pcs`}
                    hint={`${l.approved ? 'Approved' : 'Not approved'} · ${fmtDate(l.createdAt)}`} />
                ))}
              </div>
            )}
        </div>
        <div>
          <span className="label">Shipment</span>
          {src.shipments.length === 0
            ? <p className="text-xs text-amber-800">No shipment recorded yet. The shipping date will be blank until it is, or until you type it.</p>
            : (
              <div className="space-y-1">
                <Choice checked={choice.shipmentId === null} onPick={() => onChange({ shipmentId: null })} label="Choose for me" hint="The consignment furthest along." />
                {src.shipments.map((s) => (
                  <Choice key={s.id} checked={choice.shipmentId === s.id} onPick={() => onChange({ shipmentId: s.id })}
                    label={`${s.status.replace(/_/g, ' ')} — ${s.qty.toLocaleString()} pcs`}
                    hint={[s.actualShippingDate ? fmtDate(s.actualShippingDate) : null, s.awbNumber ?? s.trackingNumber].filter(Boolean).join(' · ') || 'No date or reference yet'} />
                ))}
              </div>
            )}
        </div>
        {src.pricePerPieceUsd == null && (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:col-span-2">
            This order has no unit price. The draft will be built without rates; set the price on Order Details and rebuild, or type the rates on the lines.
          </p>
        )}
      </div>
    </div>
  );
}

function Choice({ checked, onPick, label, hint }: { checked: boolean; onPick: () => void; label: string; hint?: string }) {
  return (
    <button type="button" onClick={onPick}
      className={clsx('flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left', checked ? 'border-accent-500 bg-accent-50' : 'border-ink-200 hover:bg-ink-50')}>
      <span className={clsx('mt-1 h-2.5 w-2.5 shrink-0 rounded-full border', checked ? 'border-accent-600 bg-accent-600' : 'border-ink-400')} />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-ink-800">{label}</span>
        {hint && <span className="block text-2xs text-ink-500">{hint}</span>}
      </span>
    </button>
  );
}

// ── Company letterhead ───────────────────────────────────────────────────────

type ProfileDraft = Omit<CompanyProfileDto, 'updatedAt'>;

const EMPTY_PROFILE: ProfileDraft = {
  name: 'Soccertex', tagline: null, address: null, taxId: null, email: null, phone: null, website: null,
  bankDetails: null, invoiceTerms: null, paymentTerms: null, qizRef: null, signatory: null, stampDataUrl: null,
};

/**
 * A stamp image as a small data URL: drawn down to 600px wide at most, so a
 * phone photo of the stamp does not become a megabyte on every document.
 */
function readStamp(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 600 / img.width, 600 / img.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      // A drawn stamp stays a crisp PNG; a photo of one would be far too big as PNG, so it goes as JPEG.
      const png = canvas.toDataURL('image/png');
      resolve(file.type === 'image/jpeg' || png.length > 250_000 ? canvas.toDataURL('image/jpeg', 0.85) : png);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image.')); };
    img.src = url;
  });
}

function CompanyPanel() {
  const { can, isSuperAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const editable = isSuperAdmin && can('settings:manage');
  const profile = useQuery({ queryKey: ['company-profile'], queryFn: api.invoices.company });
  const [draft, setDraft] = useState<ProfileDraft | null>(null);

  useEffect(() => {
    if (profile.data) { const { updatedAt: _u, ...rest } = profile.data.data; setDraft(rest); }
  }, [profile.data]);

  const save = useMutation({
    mutationFn: (d: ProfileDraft) => api.invoices.saveCompany(d),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['company-profile'] }); toast.success('Letterhead saved. New and rebuilt drafts will carry it.'); },
    onError: (e) => toast.error(e),
  });
  const fromWorkbook = useMutation({
    mutationFn: (file: File) => api.invoices.companyFromWorkbook(file),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['company-profile'] });
      void qc.invalidateQueries({ queryKey: ['invoice'] });
      toast.success(`Letterhead filled from the workbook: ${res.filled.join(', ')}.${res.notes.length ? ` ${res.notes.join(' ')}` : ''}`);
    },
    onError: (e) => toast.error(e),
  });

  if (profile.isLoading || !draft) return null;
  const p = profile.data?.data ?? { ...EMPTY_PROFILE, updatedAt: null };
  const missing = [!p.address && 'address', !p.taxId && 'tax ID', !p.bankDetails && 'bank details', !p.invoiceTerms && 'terms'].filter(Boolean) as string[];
  const set = <K extends keyof ProfileDraft>(k: K, v: string) => setDraft({ ...draft, [k]: k === 'name' ? v : (v.trim() === '' ? null : v) });
  const val = (k: keyof ProfileDraft) => draft[k] ?? '';

  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><Building2 className="h-4 w-4 text-ink-500" /> Company letterhead</span>}
        subtitle="Printed at the top of every document and in its payment block. Each document keeps the letterhead it was built with."
        action={editable ? (
          <div className="flex items-center gap-2">
            <label className="btn-secondary btn-sm cursor-pointer" title="Reads the exporter block, terms, bank account, signatory and stamp off the factory's own proforma workbook (.xlsx) and saves them here">
              {fromWorkbook.isPending ? 'Reading…' : 'Fill from proforma workbook'}
              <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" disabled={fromWorkbook.isPending}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) fromWorkbook.mutate(f); }} />
            </label>
            <button className="btn-primary btn-sm" disabled={save.isPending || !draft.name.trim()} onClick={() => save.mutate(draft)}>
              {save.isPending ? 'Saving…' : 'Save letterhead'}
            </button>
          </div>
        ) : <span className="text-2xs text-ink-500">A super administrator edits this.</span>}
      />
      {missing.length > 0 && (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          The letterhead has no {missing.join(', ')}. Documents print without {missing.length === 1 ? 'it' : 'them'} rather than with something made up.
        </p>
      )}
      <fieldset disabled={!editable} className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Company name"><input className="input" value={val('name')} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Tagline" hint="Under the name: what the company does."><input className="input" value={val('tagline')} onChange={(e) => set('tagline', e.target.value)} placeholder="Readymade garments and textiles" /></Field>
        <Field label="Tax ID"><input className="input" value={val('taxId')} onChange={(e) => set('taxId', e.target.value)} /></Field>
        <Field label="Address"><input className="input" value={val('address')} onChange={(e) => set('address', e.target.value)} placeholder="Street, zone, city, country" /></Field>
        <Field label="Email"><input className="input" type="email" value={val('email')} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Website"><input className="input" value={val('website')} onChange={(e) => set('website', e.target.value)} /></Field>
        <Field label="Phone"><input className="input" value={val('phone')} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Default payment terms" hint="Copied onto each new document; editable there."><input className="input" value={val('paymentTerms')} onChange={(e) => set('paymentTerms', e.target.value)} placeholder="COD · 50% in advance, balance before shipping" /></Field>
        <Field label="QIZ Ref. No." hint="In the exporter block of every document."><input className="input" value={val('qizRef')} onChange={(e) => set('qizRef', e.target.value)} placeholder="259" /></Field>
        <Field label="Signed by" hint="Printed under “For and in behalf of …”."><input className="input" value={val('signatory')} onChange={(e) => set('signatory', e.target.value)} placeholder="Dr. Amr Sheha" /></Field>
        <Field label="Company stamp" hint="PNG or JPEG; printed by the signature.">
          <div className="flex items-center gap-3">
            {draft.stampDataUrl
              ? <img src={draft.stampDataUrl} alt="Company stamp" className="h-12 max-w-[10rem] object-contain" />
              : <span className="text-2xs text-ink-400">No stamp</span>}
            {editable && (
              <>
                <label className="btn-secondary btn-sm cursor-pointer">
                  {draft.stampDataUrl ? 'Replace' : 'Upload'}
                  <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => {
                    const f = e.target.files?.[0]; e.target.value = '';
                    if (f) readStamp(f).then((d) => setDraft({ ...draft, stampDataUrl: d })).catch((err: Error) => toast.error(err));
                  }} />
                </label>
                {draft.stampDataUrl && <button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => setDraft({ ...draft, stampDataUrl: null })}>Remove</button>}
              </>
            )}
          </div>
        </Field>
        <div className="sm:col-span-2 lg:col-span-3 grid gap-3 sm:grid-cols-2">
          <Field label="Payment details" hint="One per line as “Bank: National Bank of Egypt”; each prints as label : value.">
            <textarea className="input min-h-[7rem] font-mono text-xs" value={val('bankDetails')} onChange={(e) => set('bankDetails', e.target.value)} placeholder={'Bank name\nA/C name: …\nSWIFT: …\nUSD IBAN: …'} />
          </Field>
          <Field label="Default terms & conditions" hint="One per line; numbered on the document, with the bank details under them.">
            <textarea className="input min-h-[7rem] text-xs" value={val('invoiceTerms')} onChange={(e) => set('invoiceTerms', e.target.value)} placeholder={'Goods are of Egyptian origin.\nPrices are valid for 14 days.\nPayment 50% in advance, balance before shipping.'} />
          </Field>
        </div>
      </fieldset>
      {p.updatedAt && <p className="border-t border-ink-100 px-4 py-2 text-2xs text-ink-500">Last saved {fmtDate(p.updatedAt)}.</p>}
    </Card>
  );
}
