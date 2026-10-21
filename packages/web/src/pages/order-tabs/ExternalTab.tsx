/**
 * External operations: work sent outside the factory and brought back.
 *
 * Nothing here waits on customer approval — the factory does not use it — so
 * every operation not yet sent can be sent.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalWorkEditor, type ExternalOpRow } from '../../components/ExternalWorkEditor';
import { Send, Plus } from 'lucide-react';
import { fmtDate, QtyLedger, type OrderDetailDto } from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, Modal, Num, FreeText, Spinner, EmptyState, clsx,
} from '../../components/ui';
import { AttachmentsPanel } from '../../components/Attachments';
import { CutOrderGrid } from '../../components/CutOrderGrid';
import { ComboSelect } from '../../components/ComboSelect';

interface Op {
  id: string; externalFactoryName: string | null; externalReference: string | null;
  externalFactoryId: string | null; operationSort: string | null; colorIds: string[];
  operationType: string; operationTypeAr: string | null; qty: number;
  unitRate: number | null; unitPriceUsd: number | null; totalPriceUsd: number | null;
  sentDate: string | null; expectedReturnDate: string | null; actualReturnDate: string | null;
  status: string; notes: string | null;
  daysLate: number | null;
}

const OP_TONE: Record<string, string> = {
  NOT_SENT: 'bg-ink-100 text-ink-600 ring-ink-500/20',
  SENT: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  IN_PROGRESS: 'bg-accent-50 text-accent-700 ring-accent-600/20',
  RETURNED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  CANCELLED: 'bg-ink-100 text-ink-500 ring-ink-500/20',
};

export function ExternalTab({ order, onJump }: {
  order: OrderDetailDto;
  /** Same signature the workspace hands the other tabs, so the empty cut-order
   *  state can send the user to the step that generates it. */
  onJump?: (tab: string, ledger?: string | null) => void;
}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [refusal, setRefusal] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [headEditing, setHeadEditing] = useState(false);
  const [headErr, setHeadErr] = useState<string | null>(null);

  /**
   * The sheet's header block, as a form.
   *
   * Every value here belongs to the order, so this writes to the order — the
   * same PATCH the Order Details screen uses. Two screens editing one field is
   * fine; two screens with two ways of saving it is not.
   */
  const [head, setHead] = useState({
    poNumber: order.poNumber,
    poDate: order.poDate?.slice(0, 10) ?? '',
    orderName: order.orderName,
    itemType: order.itemType ?? '',
    gender: order.gender ?? '',
    coordinatorId: order.coordinator?.id ?? '',
    clientId: order.client.id,
    externalReference: order.externalReference ?? '',
    externalWorkType: order.externalWorkType ?? '',
    externalWorkSort: order.externalWorkSort ?? '',
    externalFactoryId: order.externalFactory?.id ?? '',
    fabricDeliveryToSupplier: order.fabricDeliveryToSupplier?.slice(0, 10) ?? '',
    requiredDeliveryDate: order.requiredDeliveryDate?.slice(0, 10) ?? '',
    supplierDeliveryDate: order.supplierDeliveryDate?.slice(0, 10) ?? '',
    fabric: order.fabric ?? '',
    fabric2: order.fabric2 ?? '',
    fabric3: order.fabric3 ?? '',
    externalNotes: order.notes.external ?? '',
  });

  const saveHead = useMutation({
    mutationFn: () => {
      const { externalNotes, ...rest } = head;
      return api.orders.update(order.id, { ...rest, notes: { external: externalNotes } });
    },
    onSuccess: () => {
      setHeadEditing(false); setHeadErr(null);
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: (e) => setHeadErr(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const ops = useQuery({ queryKey: ['external-ops', order.id], queryFn: () => api.external.operations(order.id) });
  // Shares the Quantity tab's cache key, so opening one warms the other and the
  // two screens can never show different cut quantities.
  const matrixQuery = useQuery({ queryKey: ['matrix', order.id], queryFn: () => api.orders.matrix(order.id) });
  const lookups = useQuery({ queryKey: ['lookups'], queryFn: api.reference.lookups });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['external-ops', order.id] });
    void qc.invalidateQueries({ queryKey: ['order', order.id] });
  };

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.external.setStatus(id, { status }),
    onSuccess: invalidate,
    onError: (e) => setRefusal(e instanceof ApiError ? e.message : 'Could not change the status.'),
  });

  if (ops.isLoading) return <Spinner />;

  const operations = (ops.data?.data ?? []) as unknown as Op[];

  /**
   * Colour ids on an operation, as the names the order calls them.
   *
   * Resolved from `colorProgress`, which is the order's colour list with its
   * quantities already worked out — there is no separate colours array, and
   * adding one to carry names the order already publishes would be a second
   * source of the same truth.
   */
  const colourNames = (ids: string[] = []) =>
    ids
      .map((id) => order.colorProgress.find((c) => c.colorId === id)?.colorName)
      .filter((n): n is string => !!n);

  if (editing) {
    const rows: ExternalOpRow[] = operations.map((o) => ({
      id: o.id,
      operationType: o.operationType,
      operationSort: o.operationSort ?? null,
      externalFactoryId: o.externalFactoryId ?? null,
      externalReference: o.externalReference ?? null,
      qty: o.qty,
      unitPriceUsd: o.unitPriceUsd ?? null,
      expectedReturnDate: o.expectedReturnDate ?? null,
      notes: o.notes ?? null,
      status: o.status,
    }));

    return (
      <div className="space-y-4 p-5">
        <Card>
          <CardHeader
            title="External work"
            subtitle="Book the operations sent outside the factory, with their quantities and rates."
            action={<button className="btn-secondary btn-sm" onClick={() => setEditing(false)}>Done</button>}
          />
          <div className="p-4">
            <ExternalWorkEditor
              orderId={order.id}
              initial={rows}
              factories={(lookups.data?.factories ?? []).filter((f) => f.isExternal)}
              workTypes={(lookups.data?.values?.EXTERNAL_WORK_TYPE ?? []).map((v) => v.value)}
              onSaved={() => { setEditing(false); invalidate(); }}
            />
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-5">
      {can('external:write') && (
        <div className="flex justify-end">
          <button className="btn-secondary btn-sm" onClick={() => setEditing(true)}>
            <Plus className="h-3.5 w-3.5" /> Add or edit operations
          </button>
        </div>
      )}

      {/* ── External Order_Ex.Op ──────────────────────────────────────────
          The sheet's own header block: the order's facts down the left, the
          supplier's down the right, in that sequence. Everything here belongs
          to the order rather than to any one operation, which is why it sits
          above the operations table rather than inside it. */}
      <Card>
        <CardHeader
          title="External order"
          subtitle="What is being sent out, and to whom."
          action={can('order:edit') ? (
            headEditing ? (
              <div className="flex gap-2">
                <button className="btn-secondary btn-sm" onClick={() => { setHeadEditing(false); setHeadErr(null); }}>
                  Cancel
                </button>
                <button className="btn-primary btn-sm" disabled={saveHead.isPending} onClick={() => saveHead.mutate()}>
                  {saveHead.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
            ) : (
              <button className="btn-secondary btn-sm" onClick={() => setHeadEditing(true)}>Edit</button>
            )
          ) : undefined}
        />

        {headErr && <div className="px-4 pt-3"><p className="text-sm text-red-700">{headErr}</p></div>}

        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <dl className="space-y-1.5">
            <SheetField label="PO no." editing={headEditing} value={head.poNumber} display={order.poNumber} mono
              onChange={(v) => setHead({ ...head, poNumber: v })} />
            <SheetField label="PO date" editing={headEditing} type="date" value={head.poDate} display={fmtDate(order.poDate)}
              onChange={(v) => setHead({ ...head, poDate: v })} />
            <SheetField label="Order name" editing={headEditing} value={head.orderName} display={order.orderName}
              onChange={(v) => setHead({ ...head, orderName: v })} />
            <SheetField label="Item type" editing={headEditing} value={head.itemType} display={order.itemType}
              options={(lookups.data?.values?.ITEM_TYPE ?? []).map((v) => v.value)}
              onChange={(v) => setHead({ ...head, itemType: v })} />
            <SheetField label="Gender" editing={headEditing} value={head.gender} display={order.gender}
              options={(lookups.data?.values?.GENDER ?? []).map((v) => v.value)}
              onChange={(v) => setHead({ ...head, gender: v })} />
            <SheetField label="Coordinator" editing={headEditing} value={head.coordinatorId} display={order.coordinator?.name}
              choices={(lookups.data?.users ?? []).map((u) => ({ id: u.id, name: u.name }))}
              onChange={(v) => setHead({ ...head, coordinatorId: v })} />
            <SheetField label="Client" editing={headEditing} value={head.clientId} display={order.client.name}
              choices={(lookups.data?.clients ?? []).map((c) => ({ id: c.id, name: c.name }))}
              onChange={(v) => setHead({ ...head, clientId: v })} />
            <SheetField label="External reference" editing={headEditing} value={head.externalReference} display={order.externalReference}
              onChange={(v) => setHead({ ...head, externalReference: v })} />
            <SheetField label="External work type" editing={headEditing} value={head.externalWorkType} display={order.externalWorkType}
              options={(lookups.data?.values?.EXTERNAL_WORK_TYPE ?? []).map((v) => v.value)}
              onChange={(v) => setHead({ ...head, externalWorkType: v })} />
            <SheetField label="External work sort" editing={headEditing} value={head.externalWorkSort} display={order.externalWorkSort}
              options={(lookups.data?.values?.EXTERNAL_WORK_SORT ?? []).map((v) => v.value)}
              onChange={(v) => setHead({ ...head, externalWorkSort: v })} />
            <SheetRow
              label="External price in US$"
              value={
                // Not editable, and not a field: each operation carries its own
                // rate, so this is the sum of what has been booked. Editing it
                // would be editing a total, which changes nothing underneath.
                operations.some((o) => o.unitPriceUsd != null)
                  ? `$${operations.reduce((a, o) => a + (o.totalPriceUsd ?? 0), 0).toFixed(2)} across ${operations.length} operation${operations.length === 1 ? '' : 's'}`
                  : null
              }
            />
          </dl>

          <dl className="space-y-1.5">
            <SheetField label="Factory name" editing={headEditing} value={head.externalFactoryId} display={order.externalFactory?.name}
              choices={(lookups.data?.factories ?? []).filter((f) => f.isExternal).map((f) => ({ id: f.id, name: f.name }))}
              onChange={(v) => setHead({ ...head, externalFactoryId: v })} />
            <SheetField label="Fabric delivery date to supplier" editing={headEditing} type="date"
              value={head.fabricDeliveryToSupplier} display={fmtDate(order.fabricDeliveryToSupplier)}
              onChange={(v) => setHead({ ...head, fabricDeliveryToSupplier: v })} />
            <SheetField label="Required delivery date" editing={headEditing} type="date" highlight
              value={head.requiredDeliveryDate} display={fmtDate(order.requiredDeliveryDate)}
              onChange={(v) => setHead({ ...head, requiredDeliveryDate: v })} />
            <SheetField label="Delivery time from supplier" editing={headEditing} type="date"
              value={head.supplierDeliveryDate} display={fmtDate(order.supplierDeliveryDate)}
              onChange={(v) => setHead({ ...head, supplierDeliveryDate: v })} />

            {/* Three slots, as the sheet has, rather than one joined string —
                they are three separate columns and always were. */}
            <SheetField label="Fabric" editing={headEditing} value={head.fabric} display={order.fabric}
              options={(lookups.data?.values?.FABRIC ?? []).map((v) => v.value)}
              onChange={(v) => setHead({ ...head, fabric: v })} />
            <SheetField label="Fabric 2" editing={headEditing} value={head.fabric2} display={order.fabric2}
              options={(lookups.data?.values?.FABRIC ?? []).map((v) => v.value)}
              onChange={(v) => setHead({ ...head, fabric2: v })} />
            <SheetField label="Fabric 3" editing={headEditing} value={head.fabric3} display={order.fabric3}
              options={(lookups.data?.values?.FABRIC ?? []).map((v) => v.value)}
              onChange={(v) => setHead({ ...head, fabric3: v })} />

            <div className="pt-1">
              <p className="label mb-1">External notes</p>
              {headEditing ? (
                <textarea className="input min-h-[5rem]" value={head.externalNotes}
                  onChange={(e) => setHead({ ...head, externalNotes: e.target.value })} />
              ) : (
                <div className="rounded-md border border-ink-200 bg-ink-50/60 p-2.5">
                  <FreeText text={order.notes.external} />
                </div>
              )}
            </div>
          </dl>
        </div>
      </Card>

      {/* The cut order, right under what is being sent out — so a printing
          quantity can be read against the quantity there is to print on,
          without opening another tab and remembering a number. */}
      <CutOrderGrid
        data={matrixQuery.data}
        isLoading={matrixQuery.isLoading}
        onOpenCutOrder={() => onJump?.('quantity', QtyLedger.CUT)}
      />

      {/* Operations */}
      <Card>
        <CardHeader
          title="External operations"
          subtitle={`${operations.length} operation${operations.length === 1 ? '' : 's'}${order.externalWorkType ? ` · ${order.externalWorkType}` : ''}`}
        />
        {operations.length === 0 ? (
          <EmptyState title="No external operations" detail="Printing and embroidery sent to a subcontractor appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Operation</th>
                  <th className="th">Factory</th>
                  <th className="th">Colours</th>
                  <th className="th text-right">Qty</th>
                  <th className="th text-right">Rate</th>
                  <th className="th">Sent</th>
                  <th className="th">Expected back</th>
                  <th className="th">Status</th>
                  <th className="th">Notes</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {operations.map((op) => {
                  return (
                    <tr key={op.id}>
                      <td className="td">
                        <p className="font-medium text-ink-800">{op.operationType}</p>
                        {op.operationTypeAr && (
                          <p className="text-2xs text-ink-500"><FreeText text={op.operationTypeAr} /></p>
                        )}
                      </td>
                      <td className="td text-xs">{op.externalFactoryName || '—'}</td>
                      <td className="td text-xs">
                        {/* The sheet's Items/Color block. Which colours go out is
                            recorded per operation; how many of each is not, so the
                            colours are listed and no per-colour quantity is
                            implied by splitting the total between them. */}
                        {colourNames(op.colorIds).join(', ') || '—'}
                      </td>
                      <td className="td text-right"><Num value={op.qty} /></td>
                      <td className="td text-right text-xs"><Num value={op.unitRate} places={3} fallback="—" /></td>
                      <td className="td text-xs">{fmtDate(op.sentDate)}</td>
                      <td className="td text-xs">
                        {fmtDate(op.expectedReturnDate)}
                        {op.daysLate != null && op.daysLate > 0 && (
                          <span className="ml-1 font-semibold text-red-600">{op.daysLate}d late</span>
                        )}
                      </td>
                      <td className="td">
                        <span className={clsx('chip', OP_TONE[op.status])}>
                          {op.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="td max-w-[14rem] truncate text-xs text-ink-500">{op.notes || '—'}</td>
                      <td className="td text-right">
                        {can('external:write') && op.status !== 'RETURNED' && (
                          <div className="flex justify-end gap-1">
                            {op.status === 'NOT_SENT' && (
                              <button
                                onClick={() => setStatus.mutate({ id: op.id, status: 'SENT' })}
                                className="btn-primary btn-sm"
                                title="Send to the external factory"
                              >
                                <Send className="h-3 w-3" /> Send
                              </button>
                            )}
                            {(op.status === 'SENT' || op.status === 'IN_PROGRESS') && (
                              <button
                                onClick={() => setStatus.mutate({ id: op.id, status: 'RETURNED' })}
                                className="btn-secondary btn-sm"
                              >
                                Mark returned
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* The refusal, explained rather than thrown away. */}
      <Modal
        open={!!refusal} onClose={() => setRefusal(null)}
        title="The status could not be changed"
        footer={<button onClick={() => setRefusal(null)} className="btn-primary">Understood</button>}
      >
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5">
          <p className="text-sm leading-relaxed text-red-900">{refusal}</p>
        </div>
      </Modal>

      <AttachmentsPanel
        orderId={order.id}
        documentType="EXTERNAL_OP_DOC"
        stageKey="EXTERNAL_ORDER"
        title="External work files"
        detail="Artwork sent out, and paperwork that came back with the work."
      />
    </div>
  );
}

function SheetRow({
  label, value, mono, highlight,
}: {
  label: string; value: string | null | undefined; mono?: boolean; highlight?: boolean;
}) {
  return (
    <div className={clsx(
      'flex items-baseline gap-3 border-b border-ink-100 py-1 last:border-0',
      highlight && 'rounded bg-amber-50 px-1.5',
    )}>
      <dt className="w-52 shrink-0 text-xs font-medium text-ink-500">{label}</dt>
      <dd className={clsx('min-w-0 flex-1 text-sm text-ink-900', mono && 'font-mono')}>
        {value || <span className="text-ink-400">—</span>}
      </dd>
    </div>
  );
}

/**
 * One row of the sheet's header block, readable or editable in place.
 *
 * Three inputs behind one label, chosen by which props arrive: `choices` for
 * something stored by id and shown by name, `options` for a reference-value
 * list, and a plain box otherwise. One component rather than three because the
 * caller's job is to say what the field *is*, not to pick a widget — and
 * because a row that changes shape between reading and editing is how a layout
 * stops matching the sheet it was copied from.
 */
function SheetField({
  label, editing, value, display, onChange, options, choices, type, mono, highlight,
}: {
  label: string;
  editing: boolean;
  value: string;
  display: string | null | undefined;
  onChange: (v: string) => void;
  options?: string[];
  choices?: Array<{ id: string; name: string }>;
  type?: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={clsx(
      'flex items-baseline gap-3 border-b border-ink-100 py-1 last:border-0',
      highlight && 'rounded bg-amber-50 px-1.5',
    )}>
      <dt className="w-52 shrink-0 text-xs font-medium text-ink-500">{label}</dt>
      <dd className="min-w-0 flex-1">
        {!editing ? (
          <span className={clsx('text-sm text-ink-900', mono && 'font-mono')}>
            {display || <span className="text-ink-400">—</span>}
          </span>
        ) : choices ? (
          <ComboSelect className="input" value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </ComboSelect>
        ) : options && options.length > 0 ? (
          <>
            <ComboSelect
              allowCustom
              className="input mb-1"
              value={value}
              onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
            >
              <option value="">Choose…</option>
              {options.map((o) => <option key={o} value={o}>{o}</option>)}
            </ComboSelect>
            {/* The list is what is used today, not the only thing allowed. */}
            <input className="input" value={value} placeholder="or type" onChange={(e) => onChange(e.target.value)} />
          </>
        ) : (
          <input className="input" type={type ?? 'text'} value={value} onChange={(e) => onChange(e.target.value)} />
        )}
      </dd>
    </div>
  );
}
