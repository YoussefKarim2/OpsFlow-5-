/**
 * Microsoft 365 email — is it working, and if not, why not.
 *
 * The one screen that answers "I changed an order and nobody got an email".
 * It shows what is missing from the configuration by *name* — never a value,
 * because the client secret must not reach a browser — the delivery status of
 * recent messages, and the actual error Microsoft returned for the failed ones.
 *
 * The test button sends one real email, to the signed-in person only. That is
 * the difference between believing the setup is right and knowing it.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Mail, RefreshCw, Send } from 'lucide-react';
import { fmtDate } from '@opsflow/shared';
import { api } from '../../lib/api';
import { Card, CardHeader, Spinner, EmptyState, clsx, useToast } from '../../components/ui';

const STATUS_STYLE: Record<string, { chip: string; Icon: typeof Mail }> = {
  SENT: { chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', Icon: CheckCircle2 },
  PENDING: { chip: 'bg-amber-50 text-amber-800 ring-amber-600/20', Icon: Clock },
  FAILED: { chip: 'bg-red-50 text-red-700 ring-red-600/20', Icon: AlertTriangle },
};

export function EmailStatusPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<string>('');

  const { data, isLoading } = useQuery({
    queryKey: ['email-deliveries', filter],
    queryFn: () => api.changes.emails(filter || undefined),
    refetchInterval: 30_000,
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['email-deliveries'] });

  const test = useMutation({
    mutationFn: api.changes.sendTestEmail,
    onSuccess: (r) => {
      refresh();
      if (r.status === 'SENT') toast.success(`Sent to ${r.sentTo}. Check your inbox — and junk, on a first send.`);
      else toast.error(r.error ?? r.note);
    },
    onError: (e) => toast.error(e),
  });

  const retry = useMutation({
    mutationFn: api.changes.retryEmails,
    onSuccess: (r) => {
      refresh();
      toast.success(`Tried ${r.attempted}, sent ${r.sent}.`);
    },
    onError: (e) => toast.error(e),
  });

  if (isLoading) return <Spinner label="Checking email delivery…" />;
  if (!data) return null;

  const rows = data.data;

  return (
    <Card>
      <CardHeader
        title="Email notifications"
        subtitle="Real messages sent through Microsoft 365, using Microsoft Graph"
        action={
          <div className="flex gap-2">
            <button className="btn-ghost btn-sm" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            <button
              className="btn-secondary btn-sm"
              disabled={!data.configured || test.isPending}
              onClick={() => test.mutate()}
              title={data.configured ? undefined : 'Configure Microsoft 365 first'}
            >
              <Send className="h-3.5 w-3.5" /> {test.isPending ? 'Sending…' : 'Send me a test'}
            </button>
          </div>
        }
      />

      {/* ── Configuration ─────────────────────────────────────────────────── */}
      {data.configured ? (
        <div className="flex items-start gap-2 border-b border-ink-100 bg-emerald-50 px-4 py-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <p className="text-sm text-emerald-900">
            Microsoft 365 is configured. Change notifications are sent to every active OpsFlow user.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-2 border-b border-ink-100 bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">
            <p className="font-semibold">Email is not configured yet.</p>
            <p className="mt-0.5 text-xs">
              Missing from the server's <code className="rounded bg-amber-100 px-1">.env</code>:{' '}
              {data.missingSettings.map((s) => (
                <code key={s} className="mr-1 rounded bg-amber-100 px-1 font-mono text-2xs">{s}</code>
              ))}
            </p>
            <p className="mt-1 text-xs">
              Everything else keeps working — changes are tracked and notifications appear in OpsFlow.
              Messages wait in the queue and go out once these are set.
            </p>
          </div>
        </div>
      )}

      {/* ── Counts ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-px border-b border-ink-200 bg-ink-200">
        {(['SENT', 'PENDING', 'FAILED'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(filter === s ? '' : s)}
            className={clsx(
              'bg-white px-4 py-3 text-left transition-colors hover:bg-ink-50',
              filter === s && 'bg-accent-50 hover:bg-accent-50',
            )}
          >
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
              {s.toLowerCase()}
            </p>
            <p className="tnum mt-0.5 text-xl font-semibold text-ink-900">{data.counts[s] ?? 0}</p>
          </button>
        ))}
      </div>

      {(data.counts.PENDING ?? 0) > 0 && data.configured && (
        <div className="flex items-center gap-2 border-b border-ink-100 bg-ink-50 px-4 py-2">
          <span className="text-xs text-ink-600">
            {data.counts.PENDING} message{data.counts.PENDING === 1 ? '' : 's'} waiting. They retry
            automatically.
          </span>
          <button
            className="btn-ghost btn-sm ml-auto"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            Try now
          </button>
        </div>
      )}

      {/* ── The log ───────────────────────────────────────────────────────── */}
      {rows.length === 0 ? (
        <EmptyState
          title={filter ? `No ${filter.toLowerCase()} messages` : 'No emails yet'}
          detail="An email is queued whenever somebody makes a meaningful change."
        />
      ) : (
        <ul className="divide-y divide-ink-100">
          {rows.map((r) => {
            const style = STATUS_STYLE[r.status] ?? STATUS_STYLE.PENDING!;
            return (
              <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                <style.Icon
                  className={clsx(
                    'mt-0.5 h-4 w-4 shrink-0',
                    r.status === 'SENT' ? 'text-emerald-500'
                    : r.status === 'FAILED' ? 'text-red-500' : 'text-amber-500',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{r.subject}</p>
                  <p className="mt-0.5 text-2xs text-ink-500">
                    {r.recipientCount} recipient{r.recipientCount === 1 ? '' : 's'} ·{' '}
                    {r.sentAt ? `sent ${fmtDate(r.sentAt)}` : `queued ${fmtDate(r.createdAt)}`}
                    {r.attempts > 0 && <> · {r.attempts} attempt{r.attempts === 1 ? '' : 's'}</>}
                  </p>
                  {r.lastError && (
                    <p className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 font-mono text-2xs text-red-800">
                      {r.lastError}
                    </p>
                  )}
                </div>
                <span className={clsx('chip shrink-0', style.chip)}>{r.status}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
