/**
 * A user's own notification settings, shown on the Settings page.
 *
 * One row per category (the same ten that colour the What Changed timeline
 * and the notification bell). A category with no row of its own on the
 * server is already fully on — the checkboxes below just reflect that
 * default until the user actually unchecks something.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import type { ChangeCategory, NotificationPriority } from '@opsflow/shared';
import { api } from '../lib/api';
import { Card, CardHeader, Spinner, useToast } from './ui';

interface Row {
  category: ChangeCategory;
  label: string;
  inApp: boolean;
  email: boolean;
  minPriority: NotificationPriority;
}

const PRIORITIES: NotificationPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export function NotificationPreferencesPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: api.notificationPreferences.list,
  });

  // Local editable copy, reset whenever the server data changes underneath it.
  useEffect(() => { if (data) setRows(data.data); }, [data]);

  const save = useMutation({
    mutationFn: (input: Row[]) => api.notificationPreferences.save(input),
    onSuccess: () => {
      toast.success('Notification preferences saved.');
      qc.invalidateQueries({ queryKey: ['notification-preferences'] });
    },
    onError: (e) => toast.error(e),
  });

  if (isLoading || !rows) return <Spinner label="Loading notification preferences…" />;

  const update = (category: ChangeCategory, patch: Partial<Row>) => {
    setRows((prev) => prev!.map((r) => (r.category === category ? { ...r, ...patch } : r)));
  };

  return (
    <Card>
      <CardHeader
        title="Notification preferences"
        subtitle="What you're notified about, in-app and by email, per category"
        action={
          <button className="btn-primary btn-sm" onClick={() => save.mutate(rows)} disabled={save.isPending}>
            <Save className="h-3.5 w-3.5" /> {save.isPending ? 'Saving…' : 'Save'}
          </button>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              <th className="th">Category</th>
              <th className="th text-center">In-app</th>
              <th className="th text-center">Email</th>
              <th className="th w-48">Minimum priority</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r) => (
              <tr key={r.category}>
                <td className="td font-medium">{r.label}</td>
                <td className="td text-center">
                  <input
                    type="checkbox" checked={r.inApp}
                    onChange={(e) => update(r.category, { inApp: e.target.checked })}
                  />
                </td>
                <td className="td text-center">
                  <input
                    type="checkbox" checked={r.email}
                    onChange={(e) => update(r.category, { email: e.target.checked })}
                  />
                </td>
                <td className="td">
                  <select
                    className="input input-sm"
                    value={r.minPriority}
                    onChange={(e) => update(r.category, { minPriority: e.target.value as NotificationPriority })}
                  >
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-ink-100 px-4 py-2.5 text-2xs text-ink-500">
        A category left at its default (both checked, LOW) always notifies — nothing is missed
        by accident. Raise the minimum priority to hear about fewer, more important changes only.
      </p>
    </Card>
  );
}
