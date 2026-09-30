/**
 * This order's history, in three views.
 *
 * **Changes** is what most people want: what happened to this order, newest
 * first, with the value it had before and the value it has now, and the name of
 * the person who did it. It opens first for that reason.
 *
 * **Activity** is the hand-written feed — sentences a service chose to write,
 * such as "Warehouse issued 500 poly bags". It says things a field diff cannot.
 *
 * **Field changes** is the raw audit trail: column names and stored values,
 * kept forever. Nobody browses it for pleasure; it is what settles an argument.
 *
 * Three records rather than one because they answer different questions, and
 * collapsing them would mean either losing the forensic detail or putting it in
 * front of a coordinator who wanted one sentence.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fmtDate } from '@opsflow/shared';
import { api } from '../../lib/api';
import { Card, CardHeader, Avatar, TabStrip, Spinner, EmptyState, FreeText } from '../../components/ui';
import { ChangeRow, groupByDay } from '../WhatChanged';

interface AuditRow {
  id: string; entityType: string; entityId: string; field: string;
  oldValue: string | null; newValue: string | null; actorName: string;
  reason: string | null; createdAt: string;
}

export function ActivityTab({ orderId }: { orderId: string }) {
  const [view, setView] = useState<'changes' | 'activity' | 'audit'>('changes');

  const changes = useQuery({
    queryKey: ['order-changes', orderId],
    queryFn: () => api.changes.forOrder(orderId),
  });

  const activity = useQuery({
    queryKey: ['activity', orderId],
    queryFn: () => api.orders.activity(orderId, 200),
  });
  const audit = useQuery({
    queryKey: ['audit-trail', orderId],
    queryFn: () => api.orders.auditTrail(orderId),
    enabled: view === 'audit',
  });

  return (
    <div className="p-5">
      <Card>
        <CardHeader
          title="History"
          subtitle="Everything that has happened to this order — what changed, who changed it, and when"
        />
        <div className="px-4">
          <TabStrip
            tabs={[
              { key: 'changes' as const, label: 'Changes', badge: changes.data?.data.length },
              { key: 'activity' as const, label: 'Activity', badge: activity.data?.data.length },
              { key: 'audit' as const, label: 'Field changes' },
            ]}
            active={view}
            onChange={setView}
          />
        </div>

        {view === 'changes' && (
          changes.isLoading ? <Spinner /> :
          (changes.data?.data ?? []).length === 0 ? (
            <EmptyState
              title="Nothing has changed on this order yet"
              detail="Every meaningful edit shows here — what changed, who changed it, and what the value was before."
            />
          ) : (
            <div>
              {groupByDay(changes.data!.data).map((group) => (
                <div key={group.day}>
                  <h4 className="border-b border-ink-100 bg-ink-50 px-4 py-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-500">
                    {group.day}
                  </h4>
                  <ul className="divide-y divide-ink-100">
                    {/* `compact` drops the PO chip: on one order's own page,
                        repeating its number on every row is noise. */}
                    {group.items.map((e) => <ChangeRow key={e.id} event={e} compact />)}
                  </ul>
                </div>
              ))}
            </div>
          )
        )}

        {view === 'activity' && (
          activity.isLoading ? <Spinner /> :
          (activity.data?.data ?? []).length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="relative p-4">
              {/* Timeline rail */}
              <div className="absolute bottom-4 left-[1.85rem] top-4 w-px bg-ink-200" aria-hidden />
              {activity.data!.data.map((a) => (
                <li key={a.id} className="relative flex gap-3 pb-4 last:pb-0">
                  <span className="relative z-10 shrink-0">
                    <Avatar name={a.actorName} />
                  </span>
                  <div className="min-w-0 flex-1 pt-1">
                    <p className="text-sm leading-snug text-ink-700">
                      <span className="font-medium text-ink-900">{a.actorName}</span>{' '}
                      <FreeText text={a.summary} />
                    </p>
                    <p className="mt-0.5 text-2xs text-ink-400">
                      {fmtDate(a.createdAt)} ·{' '}
                      {new Date(a.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      <span className="ml-2 rounded bg-ink-100 px-1 py-px font-mono text-[9px] uppercase text-ink-500">
                        {a.action.replace(/_/g, ' ')}
                      </span>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )
        )}

        {view === 'audit' && (
          audit.isLoading ? <Spinner /> :
          ((audit.data?.data ?? []) as AuditRow[]).length === 0 ? (
            <EmptyState
              title="No field changes recorded"
              detail="Every edit to a tracked field is logged automatically. Nothing has been changed on this order since it was created."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-ink-200 bg-ink-50">
                  <tr>
                    <th className="th">When</th>
                    <th className="th">Who</th>
                    <th className="th">Record</th>
                    <th className="th">Field</th>
                    <th className="th">From</th>
                    <th className="th">To</th>
                    <th className="th">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {(audit.data!.data as AuditRow[]).map((r) => (
                    <tr key={r.id}>
                      <td className="td text-xs">{fmtDate(r.createdAt)}</td>
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
    </div>
  );
}
