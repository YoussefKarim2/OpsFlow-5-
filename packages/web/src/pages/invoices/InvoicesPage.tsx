/**
 * Proforma / Invoice — the section in the sidebar.
 *
 * Three things on one screen: every document the factory has raised, the
 * orders that could be invoiced now, and the letterhead the documents are
 * printed with. "New document" builds a draft from an order in one step; the
 * draft opens in the editor beside its preview.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, FileText, Plus, Receipt, Search, Send } from 'lucide-react';
import {
  fmtDate, INVOICE_KIND_LABEL, INVOICE_STATUS_LABEL, InvoiceKind, InvoiceStatus,
  type CompanyProfileDto, type InvoiceCandidateDto, type InvoiceListRowDto, type OrderSummaryDto,
} from '@opsflow/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, EmptyState, ErrorNote, Field, Modal, Num, Spinner, StatTile, clsx, useDebounced, useToast,
} from '../../components/ui';

type KindFilter = '' | InvoiceKind;
type Picked = { orderId: string; poNumber: string; orderName: string; clientName: string };
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
    setCreating({ open: true, order: { orderId: o.orderId, poNumber: o.poNumber, orderName: o.orderName, clientName: o.clientName } });
    setParams({}, { replace: true });
  }, [newFor, presetOrder.data, setParams]);

  const list = useQuery({ queryKey: ['invoices', kind, status, q], queryFn: () => api.invoices.list({ kind, status, q }) });
  const candidates = useQuery({ queryKey: ['invoice-candidates'], queryFn: api.invoices.candidates, staleTime: 60_000 });

  const rows = list.data?.data ?? [];
  const all = useQuery({ queryKey: ['invoices', '', '', ''], queryFn: () => api.invoices.list(), staleTime: 60_000 });
  const stats = useMemo(() => {
    const docs = all.data?.data ?? [];
    const now = new Date();
    const thisMonth = (d: string) => { const x = new Date(d); return x.getUTCFullYear() === now.getUTCFullYear() && x.getUTCMonth() === now.getUTCMonth(); };
    const issuedInvoices = docs.filter((d) => d.kind === 'INVOICE' && d.status === 'ISSUED');
    return {
      drafts: docs.filter((d) => d.status === 'DRAFT').length,
      awaitingSend: docs.filter((d) => d.status === 'ISSUED' && !d.sentAt).length,
      issuedThisMonth: issuedInvoices.filter((d) => thisMonth(d.issuedAt ?? d.date)).reduce((a, d) => a + d.total, 0),
      issuedThisMonthCount: issuedInvoices.filter((d) => thisMonth(d.issuedAt ?? d.date)).length,
    };
  }, [all.data]);

  // Orders with goods packed or shipped and no issued invoice yet.
  const ready = useMemo(() => (candidates.data?.data ?? []).filter((c) =>
    (c.packedQty > 0 || c.shippedQty > 0)
    && !c.invoices.some((i) => i.kind === 'INVOICE' && i.status === 'ISSUED')), [candidates.data]);

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
          <CardHeader title="Ready to invoice" subtitle="Orders with goods packed or shipped and no issued invoice. One click builds the draft from the packing list." />
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
                {c.invoices.some((i) => i.status === 'DRAFT' && i.kind === 'INVOICE') ? (
                  <Link to={`/invoices/${c.invoices.find((i) => i.status === 'DRAFT' && i.kind === 'INVOICE')!.id}`} className="btn-secondary btn-sm">Open draft</Link>
                ) : can('invoice:write') ? (
                  <button className="btn-primary btn-sm" onClick={() => setCreating({ open: true, order: { orderId: c.orderId, poNumber: c.poNumber, orderName: c.orderName, clientName: c.clientName }, kind: 'INVOICE' })}>Build invoice</button>
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
          subtitle={list.data ? `${rows.length} shown` : undefined}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-md border border-ink-300 p-0.5">
                {([['', 'All'], ['INVOICE', 'Invoices'], ['PROFORMA', 'Proformas']] as Array<[KindFilter, string]>).map(([k, l]) => (
                  <button key={k} onClick={() => setKind(k)} className={clsx('rounded px-2 py-0.5 text-xs', kind === k ? 'bg-accent-600 text-white' : 'text-ink-600')}>{l}</button>
                ))}
              </div>
              <select className="input !w-auto !py-1 text-xs" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                <option value="">Any status</option>
                <option value="DRAFT">Draft</option>
                <option value="ISSUED">Issued</option>
                <option value="VOID">Void</option>
              </select>
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

function StatusChip({ status, sentAt }: { status: InvoiceStatus; sentAt?: string | null }) {
  const tone = status === 'ISSUED'
    ? (sentAt ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-blue-50 text-blue-700 ring-blue-600/20')
    : status === 'VOID' ? 'bg-red-50 text-red-700 ring-red-600/20'
    : 'bg-amber-50 text-amber-800 ring-amber-600/20';
  return <span className={clsx('chip', tone)}>{INVOICE_STATUS_LABEL[status]}</span>;
}

function Row({ r, onOpen }: { r: InvoiceListRowDto; onOpen: () => void }) {
  return (
    <tr onClick={onOpen} className="cursor-pointer hover:bg-accent-50/40">
      <td className="td">
        <p className="font-mono text-xs font-semibold text-accent-700">{r.number}</p>
        <p className="text-2xs text-ink-500">{INVOICE_KIND_LABEL[r.kind]}</p>
      </td>
      <td className="td"><StatusChip status={r.status} sentAt={r.sentAt} /></td>
      <td className="td text-xs">{fmtDate(r.date)}</td>
      <td className="td text-xs" dir="auto">{r.billTo}</td>
      <td className="td">
        <p className="font-mono text-xs text-ink-700">{r.poNumber}</p>
        <p className="max-w-[16rem] truncate text-xs text-ink-500" dir="auto">{r.orderName}</p>
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

function NewDocumentDialog({ preset, presetKind, candidates, onClose }: {
  preset: Picked | null;
  presetKind?: InvoiceKind;
  candidates: InvoiceCandidateDto[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [kind, setKind] = useState<InvoiceKind>(presetKind ?? 'INVOICE');
  const [picked, setPicked] = useState<Picked | null>(preset);
  const [term, setTerm] = useState('');
  const q = useDebounced(term, 250);
  const [packingListId, setPackingListId] = useState<string | null>(null);
  const [shipmentId, setShipmentId] = useState<string | null>(null);

  const found = useQuery({ queryKey: ['search', q], queryFn: () => api.orders.search(q), enabled: q.trim().length >= 2 });
  const sources = useQuery({
    queryKey: ['invoice-sources', picked?.orderId],
    queryFn: () => api.invoices.sources(picked!.orderId),
    enabled: !!picked && kind === 'INVOICE',
  });

  // A fresh order resets the choice of list and consignment to "let the server pick".
  useEffect(() => { setPackingListId(null); setShipmentId(null); }, [picked?.orderId]);

  const create = useMutation({
    mutationFn: () => api.invoices.create({ orderId: picked!.orderId, kind, packingListId, shipmentId }),
    onSuccess: (res) => { toast.success(`${res.data.number} built from PO ${res.data.order.poNumber}`); onClose(); navigate(`/invoices/${res.data.id}`); },
    onError: (e) => toast.error(e),
  });

  const src = sources.data?.data;
  const suggestions = term.trim().length >= 2 ? [] : candidates.slice(0, 6);
  const results: Array<Picked> = term.trim().length >= 2
    ? (found.data?.data ?? []).map((o: OrderSummaryDto) => ({ orderId: o.id, poNumber: o.poNumber, orderName: o.orderName, clientName: o.clientName }))
    : suggestions.map((c) => ({ orderId: c.orderId, poNumber: c.poNumber, orderName: c.orderName, clientName: c.clientName }));

  return (
    <Modal
      open
      onClose={onClose}
      title="New document"
      subtitle="Pick the order; the draft is built from it and opens for review."
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!picked || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Building…' : `Build ${kind === 'INVOICE' ? 'invoice' : 'proforma'}`}
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

        <Field label="Order" hint={picked ? undefined : 'Type a PO, order name or customer, or pick one of the orders ready to invoice.'}>
          {picked ? (
            <div className="flex items-center gap-3 rounded-md border border-ink-300 bg-ink-50 px-3 py-2">
              <span className="font-mono text-xs font-semibold text-accent-700">{picked.poNumber}</span>
              <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{picked.orderName}</span>
              <span className="text-xs text-ink-500">{picked.clientName}</span>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setPicked(null)}>Change</button>
            </div>
          ) : (
            <>
              <input autoFocus className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="PO, order, customer…" />
              <div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-ink-200">
                {term.trim().length < 2 && suggestions.length > 0 && (
                  <p className="bg-ink-50 px-3 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-500">Packed or shipped</p>
                )}
                {results.length === 0 ? (
                  <p className="px-3 py-3 text-center text-xs text-ink-500">{found.isFetching ? 'Searching…' : 'No orders match.'}</p>
                ) : results.map((o) => (
                  <button key={o.orderId} type="button" onClick={() => setPicked(o)}
                    className="flex w-full items-center gap-3 border-b border-ink-100 px-3 py-2 text-left last:border-0 hover:bg-ink-50">
                    <span className="font-mono text-xs font-semibold text-accent-700">{o.poNumber}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-800" dir="auto">{o.orderName}</span>
                    <span className="truncate text-xs text-ink-500">{o.clientName}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </Field>

        {picked && kind === 'INVOICE' && (
          sources.isLoading ? <Spinner label="Reading the packing lists and shipments…" /> : src && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <span className="label">Packing list</span>
                {src.packingLists.length === 0
                  ? <p className="text-xs text-amber-800">No packing list on this order. The draft will be built from the shipment, or from the ordered quantities, and say so.</p>
                  : (
                    <div className="space-y-1">
                      <Choice checked={packingListId === null} onPick={() => setPackingListId(null)} label="Choose for me" hint="The approved list with cartons, else the newest." />
                      {src.packingLists.map((l) => (
                        <Choice key={l.id} checked={packingListId === l.id} onPick={() => setPackingListId(l.id)}
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
                      <Choice checked={shipmentId === null} onPick={() => setShipmentId(null)} label="Choose for me" hint="The consignment furthest along." />
                      {src.shipments.map((s) => (
                        <Choice key={s.id} checked={shipmentId === s.id} onPick={() => setShipmentId(s.id)}
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
          )
        )}
      </div>
    </Modal>
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
  bankDetails: null, invoiceTerms: null, paymentTerms: null,
};

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
          <button className="btn-primary btn-sm" disabled={save.isPending || !draft.name.trim()} onClick={() => save.mutate(draft)}>
            {save.isPending ? 'Saving…' : 'Save letterhead'}
          </button>
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
        <div className="sm:col-span-2 lg:col-span-3 grid gap-3 sm:grid-cols-2">
          <Field label="Payment details" hint="Bank, account name, SWIFT, IBAN — one per line, printed as written.">
            <textarea className="input min-h-[7rem] font-mono text-xs" value={val('bankDetails')} onChange={(e) => set('bankDetails', e.target.value)} placeholder={'Bank name\nA/C name: …\nSWIFT: …\nUSD IBAN: …'} />
          </Field>
          <Field label="Default terms & conditions" hint="One per line; each prints as a bullet.">
            <textarea className="input min-h-[7rem] text-xs" value={val('invoiceTerms')} onChange={(e) => set('invoiceTerms', e.target.value)} placeholder={'Goods are of Egyptian origin.\nPrices are valid for 14 days.\nPayment 50% in advance, balance before shipping.'} />
          </Field>
        </div>
      </fieldset>
      {p.updatedAt && <p className="border-t border-ink-100 px-4 py-2 text-2xs text-ink-500">Last saved {fmtDate(p.updatedAt)}.</p>}
    </Card>
  );
}
