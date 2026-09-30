/**
 * Step 15 — Audit.
 *
 * The workbook's A18 is `Audit_Quality Manger`, a quality inspection sheet. But
 * "audit" in a factory means two things, and a coordinator opening this section
 * wants both: **who changed what**, and **what the inspection found**. So the
 * section carries both, change history first, because that is the question
 * asked far more often and the one the workbook could never answer at all.
 *
 * Every row is real. The change history comes from `ChangeEvent` rows written
 * by the audit middleware on the request that made the change; the field-level
 * trail underneath comes from `AuditTrail`, which records raw column values and
 * is kept forever. Neither is a UI fixture, and neither can be written by a
 * client — the actor on every row is the authenticated user the backend saw.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { fmtDate, type OrderDetailDto } from '@opsflow/shared';
import { api } from '../../lib/api';
import { Card, CardHeader, TabStrip, Spinner, EmptyState, Avatar, clsx } from '../../components/ui';
import { QualityTab } from './QualityTab';

interface AuditRow {
  id: string; entityType: string; entityId: string; field: string;
  oldValue: string | null; newValue: string | null; actorName: string;
  reason: string | null; createdAt: string;
}

type View = 'changes' | 'inspection' | 'fields';

export function OrderAuditTab({ order }: { order: OrderDetailDto }) {
  const [view, setView] = useState<View>('changes');

  const changes = useQuery({
    queryKey: ['order-changes', order.id],
    queryFn: () => api.changes.forOrder(order.id),
    enabled: view === 'changes',
  });

  const fields = useQuery({
    queryKey: ['audit-trail', order.id],
    queryFn: () => api.orders.auditTrail(order.id),
    enabled: view === 'fields',
  });

  return (
    <div className="space-y-4 p-5">
      <Card>
        <CardHeader
          title="Audit"
          subtitle="Who changed what on this order, and what the inspection found"
        />
        <div className="px-4">
          <TabStrip
            tabs={[
              { key: 'changes' as const, label: 'Change history', badge: changes.data?.data.length },
              { key: 'inspection' as const, label: 'Quality inspection' },
              { key: 'fields' as const, label: 'Field-level trail' },
            ]}
            active={view}
            onChange={setView}
          />
        </div>

        {/* ── Who changed what ─────────────────────────────────────────── */}
        {view === 'changes' && (
          changes.isLoading ? <Spinner /> :
          (changes.data?.data ?? []).length === 0 ? (
            <EmptyState
              title="Nothing has changed on this order yet"
              detail="Every meaningful edit is recorded here automatically, with the name of the person who made it and the value it had before."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-ink-200 bg-ink-50">
                  <tr>
                    <th className="th">Who</th>
                    <th className="th">What changed</th>
                    <th className="th">Previous</th>
                    <th className="th">New</th>
                    <th className="th">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {changes.data!.data.flatMap((e) =>
                    // A change that touched three fields is three rows here and
                    // one line everywhere else. This is the forensic view, so
                    // each value gets its own row rather than being summarised.
                    (e.fields.length > 0 ? e.fields : [null]).map((f, i) => (
                      <tr key={`${e.id}-${i}`}>
                        {i === 0 ? (
                          <td className="td" rowSpan={Math.max(1, e.fields.length)}>
                            <span className="flex items-center gap-1.5">
                              <Avatar name={e.actorName} size="sm" />
                              <span className="text-xs font-medium text-ink-800">{e.actorName}</span>
                            </span>
                          </td>
                        ) : null}
                        <td className="td text-sm">
                          {f ? f.label : e.summary}
                          {i === 0 && f && (
                            <span className="ml-2 text-2xs text-ink-400">{e.categoryLabel}</span>
                          )}
                        </td>
                        <td className={clsx('td text-sm', f?.oldValue ? 'text-ink-600' : 'italic text-ink-400')}>
                          {f?.oldValue ?? (f ? 'not set' : '—')}
                        </td>
                        <td className={clsx('td text-sm font-semibold', f?.newValue ? 'text-ink-900' : 'italic text-ink-400')}>
                          {f?.newValue ?? (f ? 'cleared' : '—')}
                        </td>
                        {i === 0 ? (
                          <td className="td whitespace-nowrap text-xs text-ink-500" rowSpan={Math.max(1, e.fields.length)}>
                            {fmtDate(e.createdAt)}
                            <span className="ml-1.5 text-ink-400">
                              {new Date(e.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </td>
                        ) : null}
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* ── The raw trail ────────────────────────────────────────────── */}
        {view === 'fields' && (
          fields.isLoading ? <Spinner /> :
          ((fields.data?.data ?? []) as AuditRow[]).length === 0 ? (
            <EmptyState
              title="No field changes recorded"
              detail="This is the raw column-level record, kept forever. It fills as fields are edited."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-ink-200 bg-ink-50">
                  <tr>
                    <th className="th">When</th>
                    <th className="th">Who</th>
                    <th className="th">Record</th>
                    <th className="th">Column</th>
                    <th className="th">From</th>
                    <th className="th">To</th>
                    <th className="th">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {(fields.data!.data as AuditRow[]).map((r) => (
                    <tr key={r.id}>
                      <td className="td whitespace-nowrap text-xs">{fmtDate(r.createdAt)}</td>
                      <td className="td text-xs font-medium">{r.actorName}</td>
                      <td className="td text-xs text-ink-500">{r.entityType}</td>
                      <td className="td font-mono text-2xs">{r.field}</td>
                      <td className="td max-w-[12rem] truncate text-xs text-red-700 line-through">{r.oldValue ?? '—'}</td>
                      <td className="td max-w-[12rem] truncate text-xs font-medium text-emerald-700">{r.newValue ?? '—'}</td>
                      <td className="td max-w-[14rem] truncate text-xs text-ink-500">{r.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </Card>

      {/* ── The workbook's own Audit sheet ───────────────────────────────── */}
      {view === 'inspection' && (
        <>
          <div className="flex items-start gap-2 rounded-md border border-ink-200 bg-white px-4 py-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
            <p className="text-xs text-ink-600">
              The workbook's own <span className="font-mono">Audit_Quality Manger</span> sheet: the
              AQL inspection, its sample and its result. A failed inspection blocks the order until
              the corrective action is closed.
            </p>
          </div>
          <div className="-mx-5 -mb-5">
            <QualityTab order={order} />
          </div>
        </>
      )}

      {view === 'changes' && (
        <p className="px-1 text-2xs text-ink-500">
          Looking across every order? <strong>Administration → Audit Log</strong> is this same
          record for the whole factory.
        </p>
      )}
    </div>
  );
}
