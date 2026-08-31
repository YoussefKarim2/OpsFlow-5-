/**
 * User management — the brief's section 3.
 *
 * Every button here calls an endpoint that enforces the same rule again on the
 * server. Hiding a control is a courtesy to the person using the page, never
 * the thing that stops the action: a coordinator who reaches this URL sees the
 * page shell and gets a refusal with a reason from the API.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UserPlus, ShieldCheck, KeyRound, Lock, Unlock, Ban, RotateCcw, Pencil, ShieldAlert,
} from 'lucide-react';
import { DEPARTMENT_LABEL, type Department } from '@opsflow/shared';
import { api, type AdminUser } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, ConfirmDialog, CopyableSecret, EmptyState, ErrorNote, Field,
  Modal, Spinner, clsx, useToast,
} from '../../components/ui';

const DEPARTMENTS = Object.keys(DEPARTMENT_LABEL) as Department[];

export function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: api.admin.users,
  });
  const { data: roles } = useQuery({ queryKey: ['admin', 'roles'], queryFn: api.admin.roles });
  const { data: allowlist } = useQuery({ queryKey: ['admin', 'allowlist'], queryFn: api.admin.allowlist });

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: 'disable' | 'enable' | 'reset' | 'revoke-super' | 'grant-super'; user: AdminUser }
    | null
  >(null);
  const [reason, setReason] = useState('');
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(true);

  const canManage = me?.isSuperAdmin === true;

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });

  const act = useMutation({
    mutationFn: async (input: { kind: string; user: AdminUser; reason?: string }) => {
      switch (input.kind) {
        case 'disable': return api.admin.disableUser(input.user.id, input.reason);
        case 'enable': return api.admin.enableUser(input.user.id);
        case 'unlock': return api.admin.unlockUser(input.user.id);
        case 'reset': return api.admin.resetPassword(input.user.id);
        case 'grant-super': return api.admin.setSuperAdmin(input.user.id, true);
        case 'revoke-super': return api.admin.setSuperAdmin(input.user.id, false);
        default: throw new Error(`Unknown action ${input.kind}`);
      }
    },
    onSuccess: (result, input) => {
      refresh();
      setConfirm(null);
      setReason('');
      if (input.kind === 'reset' && 'temporaryPassword' in result) {
        setSecret({ email: input.user.email, password: result.temporaryPassword });
        toast.success(`Password reset for ${input.user.email}.`);
      } else {
        toast.success(MESSAGES[input.kind]?.(input.user) ?? 'Done.');
      }
    },
    onError: (e) => toast.error(e),
  });

  const users = (data?.data ?? [])
    .filter((u) => (showInactive ? true : u.active))
    .filter((u) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return [u.name, u.email, u.roleLabel, u.department].some((v) => v.toLowerCase().includes(q));
    });

  const activeCount = (data?.data ?? []).filter((u) => u.active).length;
  const superCount = (data?.data ?? []).filter((u) => u.isSuperAdmin).length;

  if (isLoading) return <Spinner label="Loading accounts…" />;
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Users</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {activeCount} active of {data?.data.length ?? 0} accounts · {superCount} super administrator
            {superCount === 1 ? '' : 's'}
          </p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <UserPlus className="h-4 w-4" /> Create user
          </button>
        )}
      </div>

      {!canManage && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            You can see the account list but not change it. Creating, disabling, re-roling and
            resetting an account is restricted to the super administrators.
          </p>
        </div>
      )}

      <Card>
        <CardHeader
          title="Accounts"
          subtitle={`${users.length} shown`}
          action={
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-ink-600">
                <input
                  type="checkbox"
                  checked={showInactive}
                  onChange={(e) => setShowInactive(e.target.checked)}
                />
                Show disabled
              </label>
              <input
                className="input w-56"
                placeholder="Search name, email, role…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          }
        />

        {users.length === 0 ? (
          <EmptyState title="No accounts match" detail="Try clearing the search." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Name</th>
                  <th className="th">Email</th>
                  <th className="th">Role</th>
                  <th className="th">Department</th>
                  <th className="th">Status</th>
                  <th className="th">Created</th>
                  <th className="th">Last login</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {users.map((u) => (
                  <tr key={u.id} className={clsx(!u.active && 'bg-ink-50/60')}>
                    <td className="td">
                      <div className="flex items-center gap-1.5">
                        <span className={clsx('font-medium', u.active ? 'text-ink-900' : 'text-ink-500')}>
                          {u.name}
                        </span>
                        {u.isSuperAdmin && (
                          <span className="chip bg-accent-50 text-accent-700 ring-accent-200" title="Super administrator">
                            <ShieldCheck className="h-3 w-3" /> Super
                          </span>
                        )}
                        {u.id === me?.id && <span className="text-2xs text-ink-400">(you)</span>}
                      </div>
                    </td>
                    <td className="td text-ink-600">{u.email}</td>
                    <td className="td">{u.roleLabel}</td>
                    <td className="td text-ink-600">
                      {DEPARTMENT_LABEL[u.department as Department]?.en ?? u.department}
                    </td>
                    <td className="td"><StatusCell user={u} /></td>
                    <td className="td text-ink-500">{fmtDate(u.createdAt)}</td>
                    <td className="td text-ink-500">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'Never'}</td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1">
                        {canManage && (
                          <>
                            <IconButton label="Edit details" onClick={() => setEditing(u)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </IconButton>
                            <IconButton
                              label="Reset password"
                              onClick={() => setConfirm({ kind: 'reset', user: u })}
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                            </IconButton>
                            {u.lockedUntil && (
                              <IconButton
                                label="Clear sign-in lockout"
                                onClick={() => act.mutate({ kind: 'unlock', user: u })}
                              >
                                <Unlock className="h-3.5 w-3.5" />
                              </IconButton>
                            )}
                            {u.isSuperAdmin ? (
                              <IconButton
                                label="Revoke super-administrator rights"
                                onClick={() => setConfirm({ kind: 'revoke-super', user: u })}
                              >
                                <Lock className="h-3.5 w-3.5" />
                              </IconButton>
                            ) : (
                              <IconButton
                                label="Grant super-administrator rights"
                                onClick={() => setConfirm({ kind: 'grant-super', user: u })}
                              >
                                <ShieldCheck className="h-3.5 w-3.5" />
                              </IconButton>
                            )}
                            {u.active ? (
                              <IconButton
                                label="Disable account"
                                tone="danger"
                                onClick={() => setConfirm({ kind: 'disable', user: u })}
                              >
                                <Ban className="h-3.5 w-3.5" />
                              </IconButton>
                            ) : (
                              <IconButton
                                label="Re-enable account"
                                onClick={() => setConfirm({ kind: 'enable', user: u })}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </IconButton>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {allowlist && (
        <Card>
          <CardHeader
            title="Super-administrator allowlist"
            subtitle="Configured in the environment, not in the application"
          />
          <div className="space-y-2 p-4 text-sm">
            <p className="text-ink-600">
              Only these addresses may hold super-administrator rights. Being listed is not enough
              on its own — an existing super administrator must also grant the rights.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {allowlist.allowlist.length === 0 ? (
                <span className="text-ink-500">None configured.</span>
              ) : (
                allowlist.allowlist.map((e) => (
                  <code key={e} className="rounded bg-ink-100 px-1.5 py-0.5 text-2xs text-ink-700">{e}</code>
                ))
              )}
            </div>
            {allowlist.holders.some((h) => !h.effective) && (
              <p className="text-amber-800">
                {allowlist.holders.filter((h) => !h.effective).map((h) => h.email).join(', ')} still
                carries the flag but is no longer on the allowlist, so the rights do not apply.
              </p>
            )}
            <p className="text-2xs text-ink-500">
              To add the third super administrator, set <code>SUPER_ADMIN_EMAILS</code> in the
              server environment and restart the API. No code change is needed.
            </p>
          </div>
        </Card>
      )}

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}

      <CreateUserModal
        open={showCreate}
        roles={roles?.data ?? []}
        allowlist={allowlist?.allowlist ?? []}
        onClose={() => setShowCreate(false)}
        onCreated={(email, password) => {
          setShowCreate(false);
          refresh();
          if (password) setSecret({ email, password });
          toast.success(`Created the account ${email}.`);
        }}
      />

      <EditUserModal
        user={editing}
        roles={roles?.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); refresh(); toast.success('Account updated.'); }}
      />

      <ConfirmDialog
        open={confirm !== null}
        onCancel={() => { setConfirm(null); setReason(''); }}
        onConfirm={() => confirm && act.mutate({ kind: confirm.kind, user: confirm.user, reason })}
        busy={act.isPending}
        tone={confirm?.kind === 'disable' || confirm?.kind === 'revoke-super' ? 'danger' : 'primary'}
        title={confirm ? CONFIRM_COPY[confirm.kind].title : ''}
        confirmLabel={confirm ? CONFIRM_COPY[confirm.kind].confirmLabel : ''}
        requireTyped={confirm?.kind === 'disable' ? confirm.user.email : undefined}
        body={
          confirm && (
            <div className="space-y-2 text-sm text-ink-700">
              <p>{CONFIRM_COPY[confirm.kind].body(confirm.user)}</p>
              {confirm.kind === 'disable' && confirm.user.openTaskCount > 0 && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-amber-900">
                  {confirm.user.name} has {confirm.user.openTaskCount} open task
                  {confirm.user.openTaskCount === 1 ? '' : 's'} and coordinates {confirm.user.orderCount}{' '}
                  order{confirm.user.orderCount === 1 ? '' : 's'}. Disabling the account does not
                  reassign them.
                </p>
              )}
            </div>
          )
        }
      >
        {confirm?.kind === 'disable' && (
          <Field label="Reason (optional)" hint="Kept with the account and shown in the audit log.">
            <input
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Left the company, on long leave, …"
            />
          </Field>
        )}
      </ConfirmDialog>

      <Modal
        open={secret !== null}
        onClose={() => setSecret(null)}
        title="Temporary password"
        subtitle={secret?.email}
        footer={<button className="btn-primary" onClick={() => setSecret(null)}>Done</button>}
      >
        <div className="space-y-3">
          <CopyableSecret value={secret?.password ?? ''} label="Give this to the person directly" />
          <p className="text-sm text-ink-600">
            This is shown once and is not stored in readable form. They must set their own password
            the first time they sign in — until they do, the account can do nothing else.
          </p>
        </div>
      </Modal>
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function StatusCell({ user }: { user: AdminUser }) {
  if (!user.active) {
    return (
      <div>
        <span className="chip bg-ink-100 text-ink-600 ring-ink-200">Disabled</span>
        {user.disabledReason && <p className="mt-0.5 text-2xs text-ink-500">{user.disabledReason}</p>}
      </div>
    );
  }
  if (user.lockedUntil) {
    return (
      <div>
        <span className="chip bg-red-50 text-red-700 ring-red-200">Locked</span>
        <p className="mt-0.5 text-2xs text-ink-500">
          {user.failedLoginCount} failed attempt{user.failedLoginCount === 1 ? '' : 's'} · until{' '}
          {new Date(user.lockedUntil).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    );
  }
  if (user.mustChangePassword) {
    return <span className="chip bg-amber-50 text-amber-800 ring-amber-200">Password reset</span>;
  }
  return (
    <div>
      <span className="chip bg-emerald-50 text-emerald-700 ring-emerald-200">Active</span>
      {user.failedLoginCount > 0 && (
        <p className="mt-0.5 text-2xs text-amber-700">
          {user.failedLoginCount} failed attempt{user.failedLoginCount === 1 ? '' : 's'} since last sign-in
        </p>
      )}
    </div>
  );
}

function IconButton({
  label, onClick, children, tone,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  tone?: 'danger';
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={clsx(
        'rounded p-1.5 transition-colors',
        tone === 'danger'
          ? 'text-red-500 hover:bg-red-50 hover:text-red-700'
          : 'text-ink-400 hover:bg-ink-100 hover:text-ink-700',
      )}
    >
      {children}
    </button>
  );
}

interface RoleOption { key: string; label: string }

function CreateUserModal({
  open, roles, allowlist, onClose, onCreated,
}: {
  open: boolean;
  roles: RoleOption[];
  allowlist: string[];
  onClose: () => void;
  onCreated: (email: string, temporaryPassword: string | null) => void;
}) {
  const [form, setForm] = useState({
    name: '', email: '', roleKey: 'COORDINATOR', department: 'COORDINATOR' as Department,
    phone: '', isSuperAdmin: false,
  });
  const [error, setError] = useState<unknown>(null);

  const create = useMutation({
    mutationFn: () => api.admin.createUser({
      name: form.name,
      email: form.email,
      roleKey: form.roleKey,
      department: form.department,
      phone: form.phone || undefined,
      isSuperAdmin: form.isSuperAdmin || undefined,
    }),
    onSuccess: (res) => {
      onCreated(form.email, res.temporaryPassword);
      setForm({ name: '', email: '', roleKey: 'COORDINATOR', department: 'COORDINATOR', phone: '', isSuperAdmin: false });
      setError(null);
    },
    onError: setError,
  });

  const emailAllowlisted = allowlist.includes(form.email.trim().toLowerCase());

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create user"
      subtitle="The account starts with a single-use password that must be changed on first sign-in."
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={create.isPending}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => create.mutate()}
            disabled={create.isPending || form.name.trim().length < 2 || !form.email.includes('@')}
          >
            {create.isPending ? 'Creating…' : 'Create user'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error != null && <ErrorNote error={error} />}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Email">
            <input
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              autoComplete="off"
            />
          </Field>
          <Field label="Role">
            <select className="input" value={form.roleKey} onChange={(e) => setForm({ ...form, roleKey: e.target.value })}>
              {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </Field>
          <Field label="Department" hint="Decides which tasks and notifications reach them.">
            <select
              className="input"
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value as Department })}
            >
              {DEPARTMENTS.map((d) => <option key={d} value={d}>{DEPARTMENT_LABEL[d].en}</option>)}
            </select>
          </Field>
          <Field label="Phone (optional)">
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
        </div>

        <label
          className={clsx(
            'flex items-start gap-2 rounded-md border p-2.5 text-sm',
            emailAllowlisted ? 'border-ink-200' : 'border-ink-200 bg-ink-50 opacity-60',
          )}
        >
          <input
            type="checkbox"
            className="mt-0.5"
            disabled={!emailAllowlisted}
            checked={form.isSuperAdmin}
            onChange={(e) => setForm({ ...form, isSuperAdmin: e.target.checked })}
          />
          <span>
            <span className="font-medium text-ink-800">Super administrator</span>
            <span className="mt-0.5 block text-xs text-ink-500">
              {emailAllowlisted
                ? 'This address is on the allowlist, so the rights can be granted.'
                : 'Only addresses on the SUPER_ADMIN_EMAILS allowlist can be granted these rights.'}
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}

function EditUserModal({
  user, roles, onClose, onSaved,
}: {
  user: AdminUser | null;
  roles: RoleOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({ name: '', department: 'COORDINATOR' as Department, phone: '', roleKey: '' });
  const [error, setError] = useState<unknown>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Reset the form when a different row is opened.
  if (user && loadedFor !== user.id) {
    setLoadedFor(user.id);
    setForm({
      name: user.name,
      department: user.department as Department,
      phone: '',
      roleKey: user.roleKey,
    });
    setError(null);
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!user) return;
      await api.admin.updateUser(user.id, {
        name: form.name,
        department: form.department,
        ...(form.phone ? { phone: form.phone } : {}),
      });
      // The role is a separate endpoint because it is a separate permission and
      // carries its own guards (you cannot change your own, or demote the last
      // super administrator).
      if (form.roleKey !== user.roleKey) await api.admin.changeRole(user.id, form.roleKey);
    },
    onSuccess: onSaved,
    onError: setError,
  });

  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      title="Edit account"
      subtitle={user?.email}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={save.isPending}>Cancel</button>
          <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error != null && <ErrorNote error={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Role">
            <select className="input" value={form.roleKey} onChange={(e) => setForm({ ...form, roleKey: e.target.value })}>
              {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </Field>
          <Field label="Department">
            <select
              className="input"
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value as Department })}
            >
              {DEPARTMENTS.map((d) => <option key={d} value={d}>{DEPARTMENT_LABEL[d].en}</option>)}
            </select>
          </Field>
          <Field label="Phone" hint="Leave blank to keep the current number.">
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
        </div>
        <p className="text-xs text-ink-500">
          Email addresses cannot be changed here — an address is the account's identity and is what
          the super-administrator allowlist matches on.
        </p>
      </div>
    </Modal>
  );
}

// ── Copy ────────────────────────────────────────────────────────────────────

const CONFIRM_COPY: Record<
  'disable' | 'enable' | 'reset' | 'grant-super' | 'revoke-super',
  { title: string; confirmLabel: string; body: (u: AdminUser) => string }
> = {
  disable: {
    title: 'Disable this account?',
    confirmLabel: 'Disable account',
    body: (u) =>
      `${u.name} will be signed out on their next request and will not be able to sign in again. ` +
      'Their history, tasks and orders are kept.',
  },
  enable: {
    title: 'Re-enable this account?',
    confirmLabel: 'Enable account',
    body: (u) => `${u.name} will be able to sign in again with their existing password.`,
  },
  reset: {
    title: 'Reset this password?',
    confirmLabel: 'Reset password',
    body: (u) =>
      `A single-use password will be generated for ${u.email} and shown once. ` +
      'Until they set their own, the account can do nothing but change it.',
  },
  'grant-super': {
    title: 'Grant super-administrator rights?',
    confirmLabel: 'Grant rights',
    body: (u) =>
      `${u.name} will be able to create, disable, re-role and reset any account, including yours.`,
  },
  'revoke-super': {
    title: 'Revoke super-administrator rights?',
    confirmLabel: 'Revoke rights',
    body: (u) =>
      `${u.name} keeps their role and everything it grants, but will no longer be able to manage accounts.`,
  },
};

const MESSAGES: Record<string, (u: AdminUser) => string> = {
  disable: (u) => `${u.email} is disabled.`,
  enable: (u) => `${u.email} can sign in again.`,
  unlock: (u) => `Lockout cleared for ${u.email}.`,
  'grant-super': (u) => `${u.email} is now a super administrator.`,
  'revoke-super': (u) => `Super-administrator rights revoked from ${u.email}.`,
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
