/**
 * Backups — proof that the data still exists somewhere other than here.
 *
 * The point of this screen is not the buttons; it is the top line. "Last
 * backup: 40 minutes ago, 2,341 rows, emailed" is the answer to the only
 * question anyone actually has about backups, and it is a question nobody
 * thinks to ask until the morning it matters.
 *
 * Restoring is deliberately absent. That happens from the command line on the
 * server, because replacing every row in the database should take more than a
 * click in a browser somebody left open.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Database, Download, Mail, RefreshCw } from 'lucide-react';
import { fmtDate } from '@opsflow/shared';
import { api } from '../../lib/api';
import { Card, CardHeader, Spinner, EmptyState, useToast } from '../../components/ui';

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function BackupsPanel() {
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-backups'],
    queryFn: api.admin.backups,
    refetchInterval: 60_000,
  });

  const take = useMutation({
    mutationFn: api.admin.takeBackup,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['admin-backups'] });
      if (r.data.ok) {
        toast.success(
          `Backed up ${r.data.rows?.toLocaleString()} rows`
          + `${r.data.emailed ? ' and emailed a copy.' : '.'}`,
        );
      } else toast.error(r.data.error ?? 'The backup failed.');
    },
    onError: (e) => toast.error(e),
  });

  const download = useMutation({
    mutationFn: api.admin.downloadBackup,
    onError: (e) => toast.error(e),
  });

  if (isLoading) return <Spinner label="Checking backups…" />;
  if (!data) return null;

  const { backups, lastRun, emailedTo } = data.data;
  const newest = backups[0];

  return (
    <Card>
      <CardHeader
        title="Backups"
        subtitle="A full copy of the database, taken on a schedule and mailed off the server."
        action={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void qc.invalidateQueries({ queryKey: ['admin-backups'] })}
              className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
            <button
              type="button"
              disabled={take.isPending}
              onClick={() => take.mutate()}
              className="inline-flex items-center gap-1.5 rounded bg-slate-900 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              <Database className="h-4 w-4" />
              {take.isPending ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
        }
      />

      <div className="px-4 pb-4">
        {/* The headline: when, how much, and did it leave the building. */}
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          {newest ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1.5 font-medium text-slate-900">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                Last backup {ago(newest.createdAt)}
              </span>
              <span className="text-slate-600">{fmtDate(newest.createdAt)}</span>
              <span className="text-slate-600">{sizeOf(newest.bytes)}</span>
              {lastRun?.rows != null && (
                <span className="text-slate-600">{lastRun.rows.toLocaleString()} rows</span>
              )}
              {lastRun?.emailed && (
                <span className="inline-flex items-center gap-1.5 text-slate-600">
                  <Mail className="h-4 w-4" /> copy emailed to {emailedTo.length} recipient(s)
                </span>
              )}
            </div>
          ) : (
            <div className="inline-flex items-center gap-1.5 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4" />
              No backup has been taken yet on this server.
            </div>
          )}

          {lastRun && !lastRun.ok && (
            <p className="mt-2 text-sm text-red-700">
              The last attempt failed: {lastRun.error}
            </p>
          )}
        </div>

        {backups.length === 0 ? (
          <EmptyState
            title="Nothing stored here yet"
            detail="A backup is taken shortly after the server starts, and then on a schedule."
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2">Taken</th>
                <th className="py-2">File</th>
                <th className="py-2 text-right">Size</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.filename} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 text-slate-700">{fmtDate(b.createdAt)}</td>
                  <td className="py-2 font-mono text-xs text-slate-500">{b.filename}</td>
                  <td className="py-2 text-right text-slate-700">{sizeOf(b.bytes)}</td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => download.mutate(b.filename)}
                      className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                    >
                      <Download className="h-3.5 w-3.5" /> Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="mt-4 text-xs text-slate-500">
          Copies are kept on the server and emailed to {emailedTo.join(', ') || 'the super admins'}.
          To restore, run <code className="rounded bg-slate-100 px-1">npm run restore -w @opsflow/server -- &lt;file&gt; --yes</code> on
          the server. That replaces every row, so it is not available from here.
        </p>
      </div>
    </Card>
  );
}
