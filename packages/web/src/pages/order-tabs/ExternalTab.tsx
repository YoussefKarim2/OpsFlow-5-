/**
 * External operations and customer approvals.
 *
 * This tab is where the workbook's most consequential unenforced instruction
 * becomes a mechanism. `External Order!M15` says, in Arabic, "do not begin
 * printing the order until the customer approves". Here, attempting to release
 * a blocked operation returns a 409 and this screen explains why.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Send, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { fmtDate, type OrderDetailDto } from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, Modal, Field, Num, FreeText, Spinner, EmptyState, clsx,
} from '../../components/ui';

interface Op {
  id: string; externalFactoryName: string | null; externalReference: string | null;
  operationType: string; operationTypeAr: string | null; qty: number;
  unitRate: number | null; unitPriceUsd: number | null; totalPriceUsd: number | null;
  sentDate: string | null; expectedReturnDate: string | null; actualReturnDate: string | null;
  status: string; requiresApproval: boolean; approvalCleared: boolean;
  approvalStatus: string | null; approvalId: string | null; notes: string | null;
  daysLate: number | null;
}

interface Approval {
  id: string; type: string; typeLabel: string; status: string; blocking: boolean;
  requestedDate: string | null; requestedByName: string | null; sentTo: string | null;
  approvedDate: string | null; approvedByName: string | null; comment: string | null;
  daysOutstanding: number | null;
}

const OP_TONE: Record<string, string> = {
  NOT_SENT: 'bg-ink-100 text-ink-600 ring-ink-500/20',
  WAITING_APPROVAL: 'bg-red-50 text-red-700 ring-red-600/20',
  SENT: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  IN_PROGRESS: 'bg-accent-50 text-accent-700 ring-accent-600/20',
  RETURNED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  CANCELLED: 'bg-ink-100 text-ink-500 ring-ink-500/20',
};

const APPROVAL_TONE: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  APPROVED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  REJECTED: 'bg-red-50 text-red-700 ring-red-600/20',
  CHANGES_REQUESTED: 'bg-orange-50 text-orange-700 ring-orange-600/20',
};

export function ExternalTab({ order }: { order: OrderDetailDto; focus?: "external" | "approvals" }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [recording, setRecording] = useState<Approval | null>(null);

  const ops = useQuery({ queryKey: ['external-ops', order.id], queryFn: () => api.external.operations(order.id) });
  const approvals = useQuery({ queryKey: ['approvals', order.id], queryFn: () => api.external.approvals(order.id) });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['external-ops', order.id] });
    void qc.invalidateQueries({ queryKey: ['approvals', order.id] });
    void qc.invalidateQueries({ queryKey: ['order', order.id] });
  };

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.external.setStatus(id, { status }),
    onSuccess: invalidate,
    onError: (e) => setRefusal(e instanceof ApiError ? e.message : 'Could not change the status.'),
  });

  if (ops.isLoading || approvals.isLoading) return <Spinner />;

  const operations = (ops.data?.data ?? []) as unknown as Op[];
  const approvalList = (approvals.data?.data ?? []) as unknown as Approval[];
  const blocked = operations.filter((o) => o.requiresApproval && !o.approvalCleared);

  return (
    <div className="space-y-4 p-5">
      {blocked.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div>
              <p className="text-sm font-semibold text-red-900">
                {blocked.length} external operation{blocked.length === 1 ? '' : 's'} blocked on customer approval
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-red-800">
                These cannot be released to the external factory until the artwork approval is recorded.
                The system will refuse the transition — this is the enforced version of the note on the
                order sheet.
              </p>
              <p className="mt-1.5 rounded bg-white/60 px-2 py-1 text-xs" dir="rtl" lang="ar">
                برجاء عدم البدء ف طباعه الاوردر الا بعد موافقه العميل
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Approvals */}
      <Card>
        <CardHeader
          title="Customer approvals"
          subtitle={`${approvalList.filter((a) => a.status === 'PENDING').length} pending of ${approvalList.length}`}
        />
        {approvalList.length === 0 ? (
          <EmptyState title="No approvals requested" detail="Print, embroidery, colour, sample, label, packing and production approvals are tracked here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Type</th>
                  <th className="th">Status</th>
                  <th className="th">Sent to</th>
                  <th className="th">Requested</th>
                  <th className="th text-right">Outstanding</th>
                  <th className="th">Decision</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {approvalList.map((a) => (
                  <tr key={a.id} className={clsx(a.status === 'PENDING' && a.blocking && 'bg-amber-50/40')}>
                    <td className="td font-medium">
                      {a.typeLabel}
                      {a.blocking && <span className="ml-1.5 chip bg-red-50 text-red-700 ring-red-600/20">Blocking</span>}
                    </td>
                    <td className="td"><span className={clsx('chip', APPROVAL_TONE[a.status])}>{a.status.replace(/_/g, ' ')}</span></td>
                    <td className="td text-xs">{a.sentTo || '—'}</td>
                    <td className="td text-xs">{fmtDate(a.requestedDate)}</td>
                    <td className="td text-right">
                      {a.daysOutstanding != null ? (
                        <span className={clsx('tnum text-xs font-semibold', a.daysOutstanding > 5 ? 'text-red-600' : 'text-amber-600')}>
                          {a.daysOutstanding}d
                        </span>
                      ) : '—'}
                    </td>
                    <td className="td text-xs">
                      {a.approvedDate ? `${a.approvedByName ?? '—'} · ${fmtDate(a.approvedDate)}` : '—'}
                    </td>
                    <td className="td text-right">
                      {a.status === 'PENDING' && can('approval:record') && (
                        <button onClick={() => setRecording(a)} className="btn-primary btn-sm">
                          Record decision
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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
                  const isBlocked = op.requiresApproval && !op.approvalCleared;
                  return (
                    <tr key={op.id} className={clsx(isBlocked && 'bg-red-50/30')}>
                      <td className="td">
                        <p className="font-medium text-ink-800">{op.operationType}</p>
                        {op.operationTypeAr && (
                          <p className="text-2xs text-ink-500"><FreeText text={op.operationTypeAr} /></p>
                        )}
                      </td>
                      <td className="td text-xs">{op.externalFactoryName || '—'}</td>
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
                          {isBlocked && <Lock className="h-2.5 w-2.5" />}
                          {op.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="td max-w-[14rem] truncate text-xs text-ink-500">{op.notes || '—'}</td>
                      <td className="td text-right">
                        {can('external:write') && op.status !== 'RETURNED' && (
                          <div className="flex justify-end gap-1">
                            {(op.status === 'NOT_SENT' || op.status === 'WAITING_APPROVAL') && (
                              <button
                                onClick={() => setStatus.mutate({ id: op.id, status: 'SENT' })}
                                className={clsx('btn-sm', isBlocked ? 'btn-secondary opacity-70' : 'btn-primary')}
                                title={isBlocked ? 'Blocked — approval required' : 'Send to the external factory'}
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
        title="This operation cannot start yet"
        footer={<button onClick={() => setRefusal(null)} className="btn-primary">Understood</button>}
      >
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5">
          <p className="text-sm leading-relaxed text-red-900">{refusal}</p>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-600">
          The order sheet carries the instruction <span dir="rtl" lang="ar">«برجاء عدم البدء ف طباعه الاوردر الا بعد موافقه العميل»</span> —
          do not begin printing before the customer approves. In the spreadsheet that was a note
          someone had to remember. Here it is a constraint: record the approval, and the operation
          becomes releasable.
        </p>
      </Modal>

      <RecordApprovalModal
        approval={recording}
        onClose={() => setRecording(null)}
        onDone={() => { setRecording(null); invalidate(); }}
      />
    </div>
  );
}

function RecordApprovalModal({
  approval, onClose, onDone,
}: {
  approval: Approval | null; onClose: () => void; onDone: () => void;
}) {
  const [status, setStatus] = useState<'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED'>('APPROVED');
  const [by, setBy] = useState('');
  const [comment, setComment] = useState('');

  const record = useMutation({
    mutationFn: () => api.external.recordApproval(approval!.id, { status, approvedByName: by || undefined, comment: comment || undefined }),
    onSuccess: onDone,
  });

  if (!approval) return null;

  const CHOICES = [
    { key: 'APPROVED' as const, label: 'Approved', icon: CheckCircle2, tone: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
    { key: 'CHANGES_REQUESTED' as const, label: 'Changes requested', icon: Clock, tone: 'border-orange-300 bg-orange-50 text-orange-800' },
    { key: 'REJECTED' as const, label: 'Rejected', icon: XCircle, tone: 'border-red-300 bg-red-50 text-red-800' },
  ];

  return (
    <Modal
      open onClose={onClose}
      title={`Record the customer's decision`}
      subtitle={`${approval.typeLabel}${approval.sentTo ? ` · sent to ${approval.sentTo}` : ''}`}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => record.mutate()} disabled={record.isPending} className="btn-primary">
            {record.isPending ? 'Recording…' : 'Record'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          {CHOICES.map((c) => (
            <button
              key={c.key} onClick={() => setStatus(c.key)}
              className={clsx(
                'flex flex-col items-center gap-1 rounded-md border px-2 py-3 text-xs font-medium transition',
                status === c.key ? c.tone : 'border-ink-200 bg-white text-ink-500 hover:border-ink-300',
              )}
            >
              <c.icon className="h-4 w-4" />{c.label}
            </button>
          ))}
        </div>
        <Field label="Approved by" hint="The person at the customer who signed off.">
          <input value={by} onChange={(e) => setBy(e.target.value)} className="input" placeholder="John Orr" />
        </Field>
        <Field label="Comment">
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} className="input" />
        </Field>
        {status === 'APPROVED' && (
          <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            Recording this as approved unblocks the linked external operation immediately.
          </p>
        )}
      </div>
    </Modal>
  );
}
