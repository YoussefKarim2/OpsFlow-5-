/**
 * Who may work on this order.
 *
 * Access is a grant per order: several coordinators can share one, and anybody
 * without a row here cannot open it at all — the order does not appear in their
 * list and every route answers 404. Only the super administrators and the Lead
 * Coordinator see this panel, because deciding who may see an order is a
 * different power from editing one.
 *
 * The whole set is saved at once rather than a row at a time, so revoking three
 * people and adding one is a single deliberate act rather than four requests
 * that can half-fail.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus, X, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { Card, CardHeader, Spinner, ErrorNote, clsx } from './ui';

export function OrderAssignments({ orderId, canAssign }: { orderId: string; canAssign: boolean }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);

  const assignments = useQuery({
    queryKey: ['assignments', orderId],
    queryFn: () => api.orders.assignments(orderId),
  });
  const lookups = useQuery({ queryKey: ['lookups'], queryFn: api.reference.lookups, enabled: canAssign });

  const assigned = assignments.data?.data ?? [];
  const assignedIds = new Set(assigned.map((a) => a.user.id));

  const save = useMutation({
    mutationFn: (userIds: string[]) => api.orders.saveAssignments(orderId, userIds),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assignments', orderId] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      setPicking(false);
    },
  });

  if (assignments.isLoading) return <Spinner />;

  const candidates = (lookups.data?.users ?? []).filter((u) => !assignedIds.has(u.id));

  return (
    <Card>
      <CardHeader
        title="Who may work on this order"
        subtitle={
          assigned.length === 0
            ? 'Nobody is assigned. Only administrators can open it.'
            : `${assigned.length} ${assigned.length === 1 ? 'person' : 'people'} — everyone else is refused.`
        }
        action={canAssign ? (
          <button className="btn-secondary btn-sm" onClick={() => setPicking((v) => !v)}>
            <UserPlus className="h-3.5 w-3.5" /> {picking ? 'Done' : 'Change'}
          </button>
        ) : undefined}
      />

      <div className="p-4">
        {save.error ? <ErrorNote error={save.error} /> : null}

        {assigned.length === 0 ? (
          <p className="text-sm text-ink-500">
            No one is assigned yet, so this order is invisible to everybody except the people
            who hand out access.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {assigned.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{a.user.name}</p>
                  <p className="truncate text-xs text-ink-500">
                    {a.user.department}
                    {a.assignedByName ? ` · added by ${a.assignedByName}` : ' · from the order’s original coordinator'}
                  </p>
                </div>
                {!a.user.active ? (
                  <span className="chip bg-ink-100 text-ink-600 ring-ink-300/40">disabled</span>
                ) : null}
                {canAssign && (
                  <button
                    className="btn-ghost btn-sm text-red-600"
                    title={`Remove ${a.user.name}'s access`}
                    disabled={save.isPending}
                    onClick={() => save.mutate(assigned.filter((x) => x.id !== a.id).map((x) => x.user.id))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {picking && canAssign && (
          <div className="mt-3 border-t border-ink-200 pt-3">
            <p className="label">Add someone</p>
            {candidates.length === 0 ? (
              <p className="text-xs text-ink-500">Everybody already has access to this order.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    disabled={save.isPending}
                    className={clsx(
                      'rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors',
                      'bg-white text-ink-700 ring-ink-300 hover:bg-accent-50 hover:ring-accent-400',
                    )}
                    onClick={() => save.mutate([...assigned.map((a) => a.user.id), u.id])}
                  >
                    {u.name}
                    <span className="ml-1 text-ink-400">{u.department}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {canAssign ? (
          <p className="mt-3 flex items-start gap-1.5 text-2xs text-ink-500">
            <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
            Anyone not listed cannot open this order, see it in their list, or reach any part
            of its production flow.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
