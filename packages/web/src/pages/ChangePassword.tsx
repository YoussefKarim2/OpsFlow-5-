/**
 * Password change, in two situations.
 *
 * As a card inside Settings, where anyone can change their own password; and as
 * a full-page block after an administrator reset one, because a reset password
 * is a credential somebody else has seen. The block is not a redirect the user
 * could route around — the API refuses every other endpoint until the password
 * is changed, and this screen is simply the place to do it.
 */

import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, CardHeader, ErrorNote, Field, useToast } from '../components/ui';

const MIN_LENGTH = 10;

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const toast = useToast();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== newPassword;
  const unchanged = newPassword.length > 0 && newPassword === currentPassword;
  const ready = currentPassword.length > 0 && newPassword.length >= MIN_LENGTH && confirm === newPassword && !unchanged;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.auth.changePassword(currentPassword, newPassword);
      setCurrent(''); setNew(''); setConfirm('');
      toast.success('Password changed.');
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 p-4">
      {error != null && <ErrorNote error={error} />}

      <Field label="Current password">
        <input
          type="password"
          className="input"
          value={currentPassword}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>

      <Field label="New password" hint={`At least ${MIN_LENGTH} characters.`}>
        <input
          type="password"
          className="input"
          value={newPassword}
          onChange={(e) => setNew(e.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>

      <Field label="Confirm new password">
        <input
          type="password"
          className="input"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>

      {tooShort && <p className="text-xs text-amber-700">{MIN_LENGTH - newPassword.length} more character(s) needed.</p>}
      {mismatch && <p className="text-xs text-red-600">The two new passwords do not match.</p>}
      {unchanged && <p className="text-xs text-red-600">The new password must be different from the current one.</p>}

      <button type="submit" className="btn-primary" disabled={!ready || busy}>
        {busy ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}

/** The full-page version, shown when the API will not let the user do anything else. */
export function ForcedPasswordChangePage() {
  const { user, refresh, logout } = useAuth();

  return (
    <div className="flex min-h-full items-center justify-center bg-ink-100 p-6">
      <div className="w-full max-w-md">
        <div className="mb-4 flex items-start gap-2.5 rounded-md border border-amber-300 bg-amber-50 px-3.5 py-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div>
            <p className="text-sm font-medium text-amber-900">Choose a new password</p>
            <p className="mt-0.5 text-xs text-amber-800">
              An administrator reset the password for {user?.email}. Until you set your own, this is
              the only thing the account can do.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader title="New password" subtitle="Enter the temporary password you were given, then your own." />
          <ChangePasswordForm onDone={refresh} />
        </Card>

        <button className="btn-ghost btn-sm mt-3 w-full" onClick={logout}>
          Sign out instead
        </button>
      </div>
    </div>
  );
}
