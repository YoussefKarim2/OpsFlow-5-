/**
 * One document: the editor on the left, the document on the right.
 *
 * A draft is edited here and the preview follows every keystroke, because the
 * preview *is* the document — the same component prints. Issuing freezes it;
 * after that the editor is gone and only the document, printing and the
 * record-keeping actions (mark sent, void) remain.
 *
 * The facts — goods lines, manifest, reconciliation, letterhead — come from the
 * order and can be refreshed with Rebuild. What a person types stays.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, FileCheck, Lock, Plus, Printer, RefreshCw, Send, Trash2, AlertTriangle } from 'lucide-react';
import {
  computeInvoiceTotals, fmtDate, INVOICE_KIND_LABEL, InvoiceStatus, issueBlockers, lineTotal,
  type InvoiceDto, type InvoiceLineKind as LineKind,
} from '@opsflow/shared';
import { InvoiceStatusChip } from '../../components/InvoiceStatusChip';
import { api, type InvoiceEditBody } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Card, ConfirmDialog, ErrorNote, Field, Num, Spinner, clsx, useToast } from '../../components/ui';
import { InvoiceDocument } from '../../components/InvoiceDocument';
import { ComboSelect } from '../../components/ComboSelect';

interface LineDraft { kind: LineKind; description: string; size: string; quantity: string; unitPrice: string; amount: string }
/**
 * A proforma's carton. `contents` is the size list a carton copied from the
 * packing list carries; typing in the contents box replaces it with text.
 */
interface CartonDraft {
  cartonNumber: string; cartonSize: string; product: string; poNumber?: string;
  contents: Array<{ label: string; qty: number }>; contentsText: string;
  pieces: string; netKg: string; grossKg: string;
}
const contentsLabel = (c: { contents: Array<{ label: string; qty: number }> }) => c.contents.map((x) => `${x.label} × ${x.qty}`).join(', ');
const cartonPieces = (c: CartonDraft) => (c.contents.length > 0 ? c.contents.reduce((a, x) => a + x.qty, 0) : numOrNull(c.pieces) ?? 0);
interface Draft {
  date: string; dueDate: string; paymentTerms: string;
  billTo: string; billToAddress: string; billToEmail: string;
  customerReference: string; shipmentRef: string; shippedOn: string;
  coverNote: string; terms: string; bankDetails: string; notes: string;
  lineLayout: 'DETAILED' | 'SUMMARY';
  cartons: CartonDraft[];
  lines: LineDraft[];
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

function fromServer(inv: InvoiceDto): Draft {
  return {
    date: day(inv.date), dueDate: day(inv.dueDate), paymentTerms: inv.paymentTerms ?? '',
    billTo: inv.billTo, billToAddress: inv.billToAddress ?? '', billToEmail: inv.billToEmail ?? '',
    customerReference: inv.customerReference ?? '', shipmentRef: inv.shipmentRef ?? '', shippedOn: day(inv.shippedOn),
    coverNote: inv.coverNote ?? '', terms: inv.terms ?? '', bankDetails: inv.bankDetails ?? '', notes: inv.notes ?? '',
    lineLayout: inv.lineLayout,
    cartons: inv.manifest.map((c) => ({
      cartonNumber: c.cartonNumber, cartonSize: c.cartonSize ?? '', product: c.product, poNumber: c.poNumber,
      contents: c.contents, contentsText: c.contentsText ?? '',
      pieces: String(c.pieces), netKg: c.netKg == null ? '' : String(c.netKg), grossKg: c.grossKg == null ? '' : String(c.grossKg),
    })),
    lines: inv.lines.map((l) => ({
      kind: l.kind, description: l.description, size: l.size ?? '',
      quantity: l.quantity == null ? '' : String(l.quantity),
      unitPrice: l.unitPrice == null ? '' : String(l.unitPrice),
      amount: l.amount == null ? '' : String(l.amount),
    })),
  };
}

/**
 * Exactly what is on screen. A blank name or a line without a description is
 * sent as it is and refused by the server with its own sentence, rather than
 * quietly dropped so that the saved document differs from the preview.
 */
/**
 * Whether the cartons are typed here. An invoice built from a packing list
 * takes its cartons from it: they are shown, and changed on the Packing tab.
 */
const cartonsTyped = (inv: InvoiceDto) => inv.kind === 'PROFORMA' || !inv.orders.some((o) => o.packingListId);

/** What would stop a save: a carton's pieces must be a whole number. */
function cartonProblem(d: Draft): string | null {
  for (const c of d.cartons) {
    if (c.contents.length > 0) continue;
    const t = c.pieces.trim();
    if (t === '') return `Carton ${c.cartonNumber || '(no number)'}: enter its pieces.`;
    if (!/^\d+$/.test(t)) return `Carton ${c.cartonNumber || '(no number)'}: pieces must be a whole number.`;
  }
  return null;
}

function toBody(d: Draft, inv: InvoiceDto): InvoiceEditBody {
  const nn = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    date: d.date || undefined, dueDate: d.dueDate || null, paymentTerms: nn(d.paymentTerms),
    billTo: d.billTo.trim(), billToAddress: nn(d.billToAddress), billToEmail: nn(d.billToEmail),
    customerReference: nn(d.customerReference), shipmentRef: nn(d.shipmentRef), shippedOn: d.shippedOn || null,
    coverNote: nn(d.coverNote), terms: nn(d.terms), bankDetails: nn(d.bankDetails), notes: nn(d.notes),
    lineLayout: d.lineLayout,
    updatedAt: inv.updatedAt,
    cartons: !cartonsTyped(inv) ? undefined : d.cartons.map((c) => ({
      cartonNumber: c.cartonNumber.trim(), cartonSize: nn(c.cartonSize), product: c.product.trim(), poNumber: c.poNumber,
      contents: c.contents, contentsText: c.contents.length > 0 ? null : nn(c.contentsText),
      pieces: cartonPieces(c), netKg: numOrNull(c.netKg), grossKg: numOrNull(c.grossKg),
    })),
    lines: d.lines.map((l) => ({
      kind: l.kind, description: l.description.trim(), size: nn(l.size),
      quantity: l.kind === 'ITEM' ? numOrNull(l.quantity) : null,
      unitPrice: l.kind === 'ITEM' ? numOrNull(l.unitPrice) : null,
      amount: l.kind === 'EXTRA' ? numOrNull(l.amount) : null,
    })),
  };
}

/** The stored document with the draft laid over it, so the preview follows the typing. */
function preview(inv: InvoiceDto, d: Draft): InvoiceDto {
  const lines = d.lines.map((l, i) => {
    const quantity = l.kind === 'ITEM' ? numOrNull(l.quantity) : null;
    const unitPrice = l.kind === 'ITEM' ? numOrNull(l.unitPrice) : null;
    const amount = l.kind === 'EXTRA' ? numOrNull(l.amount) : null;
    return {
      id: inv.lines[i]?.id ?? `draft-${i}`, kind: l.kind, description: l.description, size: l.size.trim() || null,
      quantity, unitPrice, amount, position: i,
      lineTotal: lineTotal({ kind: l.kind, description: l.description, quantity, unitPrice, amount }),
    };
  });
  const totals = computeInvoiceTotals(lines);
  const nn = (s: string) => (s.trim() === '' ? null : s);
  return {
    ...inv, lines, totals, totalInWords: '',
    date: d.date ? `${d.date}T00:00:00.000Z` : inv.date,
    dueDate: d.dueDate ? `${d.dueDate}T00:00:00.000Z` : null,
    shippedOn: d.shippedOn ? `${d.shippedOn}T00:00:00.000Z` : null,
    paymentTerms: nn(d.paymentTerms), billTo: d.billTo, billToAddress: nn(d.billToAddress), billToEmail: nn(d.billToEmail),
    customerReference: nn(d.customerReference), shipmentRef: nn(d.shipmentRef),
    coverNote: nn(d.coverNote), terms: nn(d.terms), bankDetails: nn(d.bankDetails), notes: nn(d.notes),
    lineLayout: d.lineLayout,
    manifest: d.cartons.map((c, i) => ({
      n: i + 1, cartonNumber: c.cartonNumber, cartonSize: nn(c.cartonSize), product: c.product, poNumber: c.poNumber,
      contents: c.contents, contentsText: nn(c.contentsText), pieces: cartonPieces(c), netKg: numOrNull(c.netKg), grossKg: numOrNull(c.grossKg),
    })),
  };
}

export function InvoicePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<'issue' | 'rebuild' | 'delete' | 'void' | null>(null);
  const [voidReason, setVoidReason] = useState('');
  // The record changed on the server while there were unsaved edits here.
  const [serverChanged, setServerChanged] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['invoice', id], queryFn: () => api.invoices.get(id), enabled: !!id });
  const inv = data?.data ?? null;

  // A refetch (window focus, another user's save) must not wipe what is being
  // typed: the form resets from the server only while it has no unsaved edits.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!inv) return;
    if (!dirtyRef.current) { setDraft(fromServer(inv)); setServerChanged(false); return; }
    setServerChanged(true);
  }, [inv]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['invoice', id] });
    void qc.invalidateQueries({ queryKey: ['invoices'] });
    void qc.invalidateQueries({ queryKey: ['invoice-candidates'] });
  };
  const after = (msg: string) => () => { refresh(); setConfirm(null); toast.success(msg); };

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const problem = cartonProblem(d);
      if (problem) throw new Error(problem);
      return api.invoices.update(id, toBody(d, inv!));
    },
    // The saved copy is the new baseline, so the next refetch is not "a change".
    onSuccess: (res) => { dirtyRef.current = false; setDraft(fromServer(res.data)); after('Draft saved')(); },
    onError: (e) => toast.error(e),
  });
  const fillCartons = useMutation({
    mutationFn: () => api.invoices.cartonsFromPacking(id),
    onSuccess: (res) => {
      setDraft((d) => d && ({ ...d, cartons: res.data.map((c) => ({
        cartonNumber: c.cartonNumber, cartonSize: c.cartonSize ?? '', product: c.product, poNumber: c.poNumber,
        contents: c.contents, contentsText: '', pieces: String(c.pieces),
        netKg: c.netKg == null ? '' : String(c.netKg), grossKg: c.grossKg == null ? '' : String(c.grossKg),
      })) }));
      toast.success(`${res.data.length} carton${res.data.length === 1 ? '' : 's'} copied from the packing list. Save to keep them.`);
    },
    onError: (e) => toast.error(e),
  });
  const rebuild = useMutation({ mutationFn: () => api.invoices.rebuild(id), onSuccess: after('Rebuilt from the order'), onError: (e) => toast.error(e) });
  const issue = useMutation({ mutationFn: () => api.invoices.issue(id), onSuccess: after('Issued. The document is now the record.'), onError: (e) => toast.error(e) });
  const markSent = useMutation({ mutationFn: () => api.invoices.markSent(id), onSuccess: after('Marked as sent'), onError: (e) => toast.error(e) });
  const voidIt = useMutation({ mutationFn: () => api.invoices.void(id, voidReason), onSuccess: after('Voided. The number is kept for the record.'), onError: (e) => toast.error(e) });
  const remove = useMutation({
    mutationFn: () => api.invoices.remove(id),
    onSuccess: () => { refresh(); toast.success('Draft deleted'); navigate('/invoices'); },
    onError: (e) => toast.error(e),
  });

  const shown = useMemo(() => (inv && draft ? preview(inv, draft) : inv), [inv, draft]);
  const dirty = useMemo(() => !!(inv && draft) && JSON.stringify(draft) !== JSON.stringify(fromServer(inv)), [inv, draft]);
  dirtyRef.current = dirty;

  if (isLoading) return <Spinner label="Opening the document…" />;
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;
  if (!inv || !shown || !draft) return null;

  const isDraft = inv.status === InvoiceStatus.DRAFT;
  const editable = isDraft && can('invoice:write');
  const blockers = isDraft ? issueBlockers({ lines: shown.lines, billTo: shown.billTo, stale: inv.stale }) : [];
  const canIssue = isDraft && can('invoice:issue') && blockers.length === 0 && !dirty;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const setLine = (i: number, patch: Partial<LineDraft>) => setDraft({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const setCarton = (i: number, patch: Partial<CartonDraft>) => setDraft({ ...draft, cartons: draft.cartons.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const addCarton = () => setDraft({ ...draft, cartons: [...draft.cartons, {
    cartonNumber: String(draft.cartons.length + 1), cartonSize: draft.cartons.at(-1)?.cartonSize ?? '', product: inv.order.orderName, poNumber: undefined,
    contents: [], contentsText: '', pieces: '', netKg: '', grossKg: '',
  }] });
  const addLine = (kind: LineKind) => setDraft({ ...draft, lines: [...draft.lines, { kind, description: '', size: '', quantity: '', unitPrice: '', amount: '' }] });

  const print = () => {
    document.title = `${inv.number} — ${INVOICE_KIND_LABEL[inv.kind]}`;
    window.print();
  };

  return (
    <div className="p-5">
      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link to="/invoices" className="btn-ghost btn-sm"><ArrowLeft className="h-3.5 w-3.5" /> All documents</Link>
        <div className="min-w-0">
          <h1 className="font-mono text-lg font-semibold text-ink-900">{inv.number}</h1>
          <p className="text-xs text-ink-500">
            {INVOICE_KIND_LABEL[inv.kind]} · PO{' '}
            {inv.orders.map((o, i) => (
              <span key={o.id}>{i > 0 ? ', ' : ''}<Link to={`/orders/${o.id}`} className="font-mono text-accent-700 hover:underline">{o.poNumber}</Link></span>
            ))}
            {' '}· {inv.order.clientName}
          </p>
        </div>
        <StatusLine inv={inv} />
        <div className="ml-auto flex flex-wrap gap-2">
          {editable && (
            <>
              <button className="btn-secondary btn-sm" disabled={rebuild.isPending || dirty} onClick={() => setConfirm('rebuild')}
                title={dirty ? 'Save or undo your edits first: rebuilding reads the order again' : 'Read the order again: goods lines, cartons, reconciliation and letterhead'}>
                <RefreshCw className={clsx('h-3.5 w-3.5', rebuild.isPending && 'animate-spin')} /> Rebuild from order
              </button>
              <button className="btn-secondary btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
                {save.isPending ? 'Saving…' : dirty ? 'Save draft' : 'Saved'}
              </button>
            </>
          )}
          <button className="btn-secondary btn-sm" onClick={print} title="Opens the browser's print dialog — choose “Save as PDF” there">
            <Printer className="h-3.5 w-3.5" /> Print / PDF
          </button>
          {isDraft && can('invoice:issue') && (
            <button className="btn-primary btn-sm" disabled={!canIssue} onClick={() => setConfirm('issue')}
              title={dirty ? 'Save the draft first' : blockers[0]}>
              <FileCheck className="h-3.5 w-3.5" /> Issue
            </button>
          )}
          {inv.status === InvoiceStatus.ISSUED && !inv.sentAt && can('invoice:write') && (
            <button className="btn-primary btn-sm" disabled={markSent.isPending} onClick={() => markSent.mutate()}>
              <Send className="h-3.5 w-3.5" /> Mark as sent
            </button>
          )}
          {inv.status === InvoiceStatus.ISSUED && can('invoice:issue') && (
            <button className="btn-ghost btn-sm text-red-700 hover:bg-red-50" onClick={() => setConfirm('void')}><Ban className="h-3.5 w-3.5" /> Void</button>
          )}
          {editable && (
            <button className="btn-ghost btn-sm text-red-700 hover:bg-red-50" onClick={() => setConfirm('delete')}><Trash2 className="h-3.5 w-3.5" /> Delete draft</button>
          )}
        </div>
      </div>

      {/* ── Notices ────────────────────────────────────────────────────── */}
      {isDraft && (inv.warnings.length > 0 || inv.stale || blockers.length > 0) && (
        <div className="no-print mb-4 space-y-2">
          {inv.stale && (
            <Notice tone="amber" title="The cartons changed after this draft was built.">
              Rebuild it so the goods lines, the manifest and the reconciliation match the packing list.
            </Notice>
          )}
          {inv.warnings.length > 0 && (
            <Notice tone="blue" title="When this draft was built">
              <ul className="list-disc space-y-0.5 pl-4">{inv.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </Notice>
          )}
          {blockers.length > 0 && can('invoice:issue') && (
            <Notice tone="amber" title="Before it can be issued">
              <ul className="list-disc space-y-0.5 pl-4">{blockers.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </Notice>
          )}
        </div>
      )}
      {inv.status === InvoiceStatus.VOID && (
        <div className="no-print mb-4"><Notice tone="red" title={`Voided ${fmtDate(inv.voidedAt)}.`}>{inv.voidReason}</Notice></div>
      )}
      {serverChanged && (
        <div className="no-print mb-4">
          <Notice tone="amber" title="This document changed on the server while you were editing.">
            Your unsaved edits are still here. Save them to keep them, or{' '}
            <button type="button" className="font-semibold underline" onClick={() => { dirtyRef.current = false; setDraft(fromServer(inv)); setServerChanged(false); }}>discard them and load the latest</button>.
          </Notice>
        </div>
      )}

      {/* ── Editor + document ──────────────────────────────────────────── */}
      {/* The editor takes a fixed column so the document keeps the width it
          prints at; on a laptop screen the sheet still gets about 640px. */}
      <div className={clsx('grid gap-5', editable && 'xl:grid-cols-[21rem_minmax(0,1fr)] 2xl:grid-cols-[26rem_minmax(0,1fr)]')}>
        {editable && (
          <div className="no-print space-y-4">
            <Card>
              <div className="card-header"><h3 className="card-title">On the document</h3></div>
              <div className="space-y-2 p-4">
                <div className="flex rounded-md border border-ink-300 p-0.5" role="radiogroup" aria-label="How the goods are listed">
                  {([['DETAILED', 'By colour & size'], ['SUMMARY', 'Total only']] as const).map(([v, label]) => (
                    <button
                      key={v} type="button" role="radio" aria-checked={draft.lineLayout === v}
                      onClick={() => set('lineLayout', v)}
                      className={clsx('flex-1 rounded px-2.5 py-1 text-xs font-medium', draft.lineLayout === v ? 'bg-accent-600 text-white' : 'text-ink-600 hover:bg-ink-50')}
                    >{label}</button>
                  ))}
                </div>
                <p className="text-2xs text-ink-500">
                  {draft.lineLayout === 'SUMMARY'
                    ? 'One line per order: total pieces, rate and amount, without colours or sizes. The lines below and the totals are unchanged.'
                    : 'Every colour with its sizes, pieces, rate and amount.'}
                </p>
              </div>
            </Card>

            <Card>
              <div className="card-header"><h3 className="card-title">Lines</h3>
                <div className="flex gap-1">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => addLine('ITEM')}><Plus className="h-3.5 w-3.5" /> Goods</button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => addLine('EXTRA')}><Plus className="h-3.5 w-3.5" /> Extra / discount</button>
                </div>
              </div>
              <div className="divide-y divide-ink-100">
                {draft.lines.length === 0 && <p className="px-4 py-3 text-xs text-ink-500">No lines. Add goods, or rebuild from the order.</p>}
                {draft.lines.map((l, i) => (
                  <div key={i} className="space-y-1.5 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={clsx('chip', l.kind === 'ITEM' ? 'bg-ink-100 text-ink-600 ring-ink-300' : 'bg-violet-50 text-violet-700 ring-violet-200')}>
                        {l.kind === 'ITEM' ? 'Goods' : 'Extra'}
                      </span>
                      <input className="input !py-1 text-xs" dir="auto" value={l.description} placeholder={l.kind === 'ITEM' ? 'Item & description' : 'Extra piece · Freight · Discount'} onChange={(e) => setLine(i, { description: e.target.value })} />
                      <button type="button" className="btn-ghost btn-sm text-red-600 hover:bg-red-50" aria-label="Remove line"
                        onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                    {l.kind === 'ITEM' ? (
                      <div className="grid grid-cols-[1fr_5rem_6rem_6rem] items-center gap-1.5 text-xs">
                        <input className="input !py-1 text-xs" value={l.size} placeholder="Size" onChange={(e) => setLine(i, { size: e.target.value })} />
                        <input className="input tnum !py-1 text-right text-xs" value={l.quantity} placeholder="Qty" inputMode="decimal" onChange={(e) => setLine(i, { quantity: e.target.value })} />
                        <input className="input tnum !py-1 text-right text-xs" value={l.unitPrice} placeholder="Rate" inputMode="decimal" onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                        <span className="tnum text-right font-semibold"><Num value={lineTotal({ kind: 'ITEM', description: '', quantity: numOrNull(l.quantity), unitPrice: numOrNull(l.unitPrice), amount: null })} kind="money" fallback="—" /></span>
                      </div>
                    ) : (
                      <div className="grid grid-cols-[1fr_8rem] items-center gap-1.5 text-xs">
                        <span className="text-2xs text-ink-500">Listed under the subtotal. A negative amount is a discount.</span>
                        <input className="input tnum !py-1 text-right text-xs" value={l.amount} placeholder="Amount" inputMode="decimal" onChange={(e) => setLine(i, { amount: e.target.value })} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-baseline justify-between border-t border-ink-200 bg-ink-50 px-4 py-2 text-sm">
                <span className="font-medium text-ink-700">Total · {shown.totals.totalQty.toLocaleString()} pcs</span>
                <span className="tnum text-base font-semibold"><Num value={shown.totals.total} kind="money" /></span>
              </div>
            </Card>

            <Card>
              <div className="card-header"><h3 className="card-title">Cartons</h3>
                {cartonsTyped(inv) && <div className="flex gap-1">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => fillCartons.mutate()} disabled={fillCartons.isPending}
                    title="Copy the cartons entered on the order's Packing tab">
                    <RefreshCw className="h-3.5 w-3.5" /> {fillCartons.isPending ? 'Copying…' : 'From packing list'}
                  </button>
                  <button type="button" className="btn-ghost btn-sm" onClick={addCarton}><Plus className="h-3.5 w-3.5" /> Carton</button>
                </div>}
              </div>
              {!cartonsTyped(inv) ? (
                <p className="px-4 py-3 text-xs text-ink-600">
                  {draft.cartons.length} carton{draft.cartons.length === 1 ? '' : 's'} from the order's packing list, as printed. To change them,
                  edit the cartons on the order's Packing tab, then use <strong>Rebuild from order</strong>.
                </p>
              ) : (
              <div className="divide-y divide-ink-100">
                {draft.cartons.length === 0 && (
                  <p className="px-4 py-3 text-xs text-ink-500">No cartons yet. Add them by hand, or copy them from the order's packing list. They print as a packing list under the document.</p>
                )}
                {draft.cartons.map((c, i) => (
                  <div key={i} className="space-y-1.5 px-3 py-2.5 text-xs">
                    <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-1.5">
                      <input className="input !py-1 text-xs" value={c.cartonNumber} placeholder="Carton no." aria-label="Carton number" onChange={(e) => setCarton(i, { cartonNumber: e.target.value })} />
                      <input className="input !py-1 text-xs" dir="auto" value={c.product} placeholder="Product" aria-label="Product" onChange={(e) => setCarton(i, { product: e.target.value })} />
                      <button type="button" className="btn-ghost btn-sm text-red-600 hover:bg-red-50" aria-label="Remove carton"
                        onClick={() => setDraft({ ...draft, cartons: draft.cartons.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                    {inv.orders.length > 1 && (
                      <ComboSelect aria-label="PO" className="input !py-1 text-xs" value={c.poNumber ?? ''} onChange={(e) => setCarton(i, { poNumber: e.target.value || undefined })}>
                        <option value="">PO…</option>
                        {inv.orders.map((o) => <option key={o.poNumber} value={o.poNumber}>{`PO ${o.poNumber} · ${o.orderName}`}</option>)}
                      </ComboSelect>
                    )}
                    <input className="input !py-1 text-xs" dir="auto" aria-label="Contents" placeholder="Contents, e.g. S × 10, M × 12"
                      value={c.contents.length > 0 ? contentsLabel(c) : c.contentsText}
                      onChange={(e) => setCarton(i, { contents: [], contentsText: e.target.value })} />
                    <div className="grid grid-cols-4 gap-1.5">
                      <input className="input !py-1 text-xs" value={c.cartonSize} placeholder="Size (cm)" aria-label="Carton size" onChange={(e) => setCarton(i, { cartonSize: e.target.value })} />
                      <input className="input tnum !py-1 text-right text-xs" inputMode="numeric" aria-label="Pieces" placeholder="Pieces"
                        value={c.contents.length > 0 ? String(cartonPieces(c)) : c.pieces} disabled={c.contents.length > 0}
                        title={c.contents.length > 0 ? 'The sum of the sizes in this carton' : undefined}
                        onChange={(e) => setCarton(i, { pieces: e.target.value })} />
                      <input className="input tnum !py-1 text-right text-xs" inputMode="decimal" aria-label="Net kg" placeholder="Net kg" value={c.netKg} onChange={(e) => setCarton(i, { netKg: e.target.value })} />
                      <input className="input tnum !py-1 text-right text-xs" inputMode="decimal" aria-label="Gross kg" placeholder="Gross kg" value={c.grossKg} onChange={(e) => setCarton(i, { grossKg: e.target.value })} />
                    </div>
                  </div>
                ))}
              </div>
              )}
              {draft.cartons.length > 0 && (
                <div className="flex items-baseline justify-between border-t border-ink-200 bg-ink-50 px-4 py-2 text-sm">
                  <span className="font-medium text-ink-700">{draft.cartons.length} carton{draft.cartons.length === 1 ? '' : 's'}</span>
                  <span className="tnum font-semibold">{draft.cartons.reduce((a, c) => a + cartonPieces(c), 0).toLocaleString()} pcs</span>
                </div>
              )}
              {draft.cartons.length > 0 && draft.cartons.reduce((a, c) => a + cartonPieces(c), 0) !== shown.totals.totalQty && (
                <p className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-2xs text-amber-800">
                  The cartons hold {draft.cartons.reduce((a, c) => a + cartonPieces(c), 0).toLocaleString()} pcs; the goods lines bill {shown.totals.totalQty.toLocaleString()}. Check before issuing.
                </p>
              )}
            </Card>

            <Card>
              <div className="card-header"><h3 className="card-title">Bill to</h3></div>
              <div className="grid gap-3 p-4">
                <Field label="Name"><input className="input" dir="auto" value={draft.billTo} onChange={(e) => set('billTo', e.target.value)} /></Field>
                <Field label="Address"><textarea className="input min-h-[3.5rem]" dir="auto" value={draft.billToAddress} onChange={(e) => set('billToAddress', e.target.value)} /></Field>
                <Field label="Email"><input className="input" type="email" value={draft.billToEmail} onChange={(e) => set('billToEmail', e.target.value)} /></Field>
              </div>
            </Card>

            <Card>
              <div className="card-header"><h3 className="card-title">Dates &amp; references</h3></div>
              <div className="grid grid-cols-2 gap-3 p-4">
                <Field label={inv.kind === 'INVOICE' ? 'Invoice date' : 'Date'} hint={inv.kind === 'INVOICE' ? 'The day the goods left, unless agreed otherwise.' : undefined}>
                  <input type="date" className="input" value={draft.date} onChange={(e) => set('date', e.target.value)} />
                </Field>
                <Field label={inv.kind === 'INVOICE' ? 'Due date' : 'Valid until'}><input type="date" className="input" value={draft.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></Field>
                <Field label="Payment terms"><input className="input" value={draft.paymentTerms} onChange={(e) => set('paymentTerms', e.target.value)} placeholder="COD" /></Field>
                <Field label="Your reference" hint="The customer's own reference."><input className="input" dir="auto" value={draft.customerReference} onChange={(e) => set('customerReference', e.target.value)} /></Field>
                {inv.kind === 'INVOICE' && (
                  <>
                    <Field label="Shipment no." hint="AWB, container or your own number."><input className="input" value={draft.shipmentRef} onChange={(e) => set('shipmentRef', e.target.value)} /></Field>
                    <Field label="Shipped on"><input type="date" className="input" value={draft.shippedOn} onChange={(e) => set('shippedOn', e.target.value)} /></Field>
                  </>
                )}
              </div>
            </Card>

            <Card>
              <div className="card-header"><h3 className="card-title">Text</h3></div>
              <div className="grid gap-3 p-4">
                <Field label="Cover note" hint="Above the document, as the email reads."><textarea className="input min-h-[6rem] text-xs" dir="auto" value={draft.coverNote} onChange={(e) => set('coverNote', e.target.value)} /></Field>
                <Field label="Terms & conditions" hint="One per line."><textarea className="input min-h-[5rem] text-xs" dir="auto" value={draft.terms} onChange={(e) => set('terms', e.target.value)} /></Field>
                <Field label="Payment details"><textarea className="input min-h-[5rem] font-mono text-xs" value={draft.bankDetails} onChange={(e) => set('bankDetails', e.target.value)} /></Field>
                <Field label="Notes" hint="Printed under the invoice when filled."><textarea className="input min-h-[3rem] text-xs" dir="auto" value={draft.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
              </div>
            </Card>
          </div>
        )}

        <div className="min-w-0">
          {editable && dirty && (
            <p className="no-print mb-2 text-center text-2xs text-amber-800">The preview shows unsaved edits. Save before issuing or printing the final copy.</p>
          )}
          <InvoiceDocument doc={shown} />
          {!isDraft && (
            <p className="no-print mt-3 flex items-center justify-center gap-1.5 text-2xs text-ink-500">
              <Lock className="h-3 w-3" />
              {inv.status === InvoiceStatus.ISSUED ? `Issued ${fmtDate(inv.issuedAt)}${inv.issuedByName ? ` by ${inv.issuedByName}` : ''}. This is the record; it cannot be edited.` : 'Void. Kept for the record.'}
            </p>
          )}
        </div>
      </div>

      {/* ── Confirmations ──────────────────────────────────────────────── */}
      <ConfirmDialog
        open={confirm === 'issue'} onCancel={() => setConfirm(null)} onConfirm={() => issue.mutate()} busy={issue.isPending}
        tone="primary" title={`Issue ${inv.number}?`} confirmLabel="Issue it"
        body={<>
          <p>This freezes the document as the customer's copy: <b>{shown.totals.totalQty.toLocaleString()} pcs</b> for <b>${shown.totals.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</b>, billed to {shown.billTo}.</p>
          <p className="mt-2">It cannot be edited afterwards. A wrong invoice is voided and a new one raised.</p>
        </>}
      />
      <ConfirmDialog
        open={confirm === 'rebuild'} onCancel={() => setConfirm(null)} onConfirm={() => rebuild.mutate()} busy={rebuild.isPending}
        tone="primary" title="Rebuild from the order?" confirmLabel="Rebuild"
        body={<>
          <p>The goods lines, the manifest, the reconciliation and the letterhead are read again from the order and replace what is here.</p>
          <p className="mt-2">Kept: your extra lines, cover note, terms, bill-to block, dates and notes; a shipment number or date the order still cannot supply; and a rate you typed on a goods line the order still has no price for. Unsaved edits are lost — save first if you want them.</p>
        </>}
      />
      <ConfirmDialog
        open={confirm === 'delete'} onCancel={() => setConfirm(null)} onConfirm={() => remove.mutate()} busy={remove.isPending}
        title={`Delete draft ${inv.number}?`} confirmLabel="Delete"
        body={<p>A draft has not been sent to anyone, so deleting it leaves no record. Its number is handed back and taken by the next draft of this kind.</p>}
      />
      <ConfirmDialog
        open={confirm === 'void'} onCancel={() => setConfirm(null)} busy={voidIt.isPending}
        onConfirm={() => { if (voidReason.trim().length < 3) { toast.error(new Error('Say why it is being voided.')); return; } voidIt.mutate(); }}
        title={`Void ${inv.number}?`} confirmLabel="Void it"
        body={<>
          <p>The document keeps its number and its contents, marked void, so the numbering has no gap and the record says what was cancelled.</p>
          <Field label="Why">
            <input className="input" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Wrong quantity — reissued as INV-…" autoFocus />
          </Field>
        </>}
      />
    </div>
  );
}

function StatusLine({ inv }: { inv: InvoiceDto }) {
  return (
    <span className="ml-2 inline-flex items-center gap-2">
      <InvoiceStatusChip status={inv.status} sentAt={inv.sentAt} />
      {inv.status === 'ISSUED' && inv.sentAt && <span className="text-2xs text-ink-500">Sent {fmtDate(inv.sentAt)}</span>}
    </span>
  );
}

function Notice({ tone, title, children }: { tone: 'amber' | 'blue' | 'red'; title: string; children: React.ReactNode }) {
  const cls = tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-900'
    : tone === 'red' ? 'border-red-200 bg-red-50 text-red-900'
    : 'border-blue-200 bg-blue-50 text-blue-900';
  return (
    <div className={clsx('flex items-start gap-2.5 rounded-md border px-4 py-3 text-xs', cls)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0"><p className="font-semibold">{title}</p><div className="mt-0.5 leading-relaxed">{children}</div></div>
    </div>
  );
}
