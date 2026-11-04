/**
 * What one person can do, permission by permission.
 *
 * A super administrator ticks or unticks anything on top of the person's role.
 * Ticks that differ from the role are marked, and "Back to the role" clears
 * them. Creating, disabling and re-roling accounts are not on the list: they
 * come with being a super administrator, set from the user list itself.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GRANTABLE_PERMISSIONS, PERMISSION_GROUPS } from '@opsflow/shared';
import { api, ApiError, type AdminUser } from '../../lib/api';
import { Modal, clsx, useToast } from '../../components/ui';

export function UserAccessModal({ user, isSelf, onClose }: { user: AdminUser | null; isSelf: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const grantable = GRANTABLE_PERMISSIONS as readonly string[];
  const [ticked, setTicked] = useState<Set<string>>(() => new Set((user?.permissions ?? []).filter((p) => grantable.includes(p))));
  const role = useMemo(() => new Set(user?.rolePermissions ?? []), [user]);

  const save = useMutation({
    mutationFn: () => api.admin.setPermissions(user!.id, [...ticked]),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast.success(`Access saved for ${user!.name}. It applies from their next click.`);
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'The access could not be saved'),
  });

  if (!user) return null;
  const toggle = (p: string) => setTicked((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const setMany = (ps: readonly string[], on: boolean) => setTicked((s) => { const n = new Set(s); for (const p of ps) { if (on) n.add(p); else n.delete(p); } return n; });
  const differs = grantable.filter((p) => ticked.has(p) !== role.has(p)).length;

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={`What ${user.name} can access`}
      subtitle={`Role: ${user.roleLabel}. Tick anything to give it, untick to take it away.`}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1.5">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setMany(grantable, true)} disabled={isSelf}>Give everything</button>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => setTicked(new Set(grantable.filter((p) => role.has(p))))}
              disabled={isSelf || differs === 0}
              title="Exactly what the role gives, nothing set by hand"
            >
              Back to the role
            </button>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" onClick={() => save.mutate()} disabled={isSelf || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save access'}
            </button>
          </div>
        </div>
      }
    >
      {isSelf && (
        <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You cannot change your own access. Ask another super administrator.
        </p>
      )}
      <p className="mb-3 text-xs text-ink-500">
        <span className="font-medium text-violet-700">Violet</span> marks what is set for {user.name} alone, different from the role
        {differs > 0 ? ` (${differs})` : ''}. Creating, disabling and resetting accounts come with being a super administrator,
        which is set from the user list.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {PERMISSION_GROUPS.map((g) => {
          const keys = g.permissions.map((p) => p.key);
          const all = keys.every((k) => ticked.has(k));
          return (
            <fieldset key={g.label} className="rounded-md border border-ink-200 p-3" disabled={isSelf}>
              <legend className="flex w-full items-center justify-between gap-2 px-1 text-sm font-semibold text-ink-900">
                {g.label}
                <button type="button" className="text-2xs font-medium text-accent-700 hover:underline" onClick={() => setMany(keys, !all)}>
                  {all ? 'None' : 'All'}
                </button>
              </legend>
              <div className="space-y-1">
                {g.permissions.map((p) => {
                  const own = ticked.has(p.key) !== role.has(p.key);
                  return (
                    <label key={p.key} className={clsx('flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm', own ? 'bg-violet-50 text-violet-900' : 'text-ink-800')}>
                      <input type="checkbox" checked={ticked.has(p.key)} onChange={() => toggle(p.key)} />
                      <span className="flex-1">{p.label}</span>
                      {own && (
                        <span className="text-2xs font-medium text-violet-700">
                          {ticked.has(p.key) ? 'given' : 'taken away'}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
    </Modal>
  );
}
