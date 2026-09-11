/**
 * Scheduled database backups.
 *
 * The shape is deliberately identical to `email-queue.ts` and
 * `alert-worker.ts`: a module-level, unref'd `setInterval`, started from
 * `index.ts` and never from `app.ts`, so building an app for a test never
 * starts a timer.
 *
 * Two destinations, and the second is the one that matters:
 *
 *   **Disk** — fast, free, and holds the last few backups for a quick restore.
 *     On a container without a mounted volume this survives until the next
 *     deploy and no longer. It is a convenience, not a safety net.
 *
 *   **Email** — the backup leaves the machine. If the container, the volume and
 *     the database all disappear at once, this is the copy that still exists,
 *     because it is sitting in a mailbox on someone else's infrastructure.
 *     Unglamorous, and the only off-box channel this deployment already has
 *     credentials for.
 *
 * A backup that fails must never take the API down with it, so every failure
 * here is logged and swallowed. The next run tries again.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseEmailList } from '@opsflow/shared';
import { config, SUPER_ADMIN_EMAILS } from '../../config.js';
import { createBackup, describeBackup } from './backup-service.js';
import { sendMail, isGraphConfigured } from '../email/graph-mailer.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

/** The last run's outcome, so the admin screen can show it without a table. */
export interface BackupRunSummary {
  at: string;
  ok: boolean;
  filename?: string;
  bytes?: number;
  rows?: number;
  tables?: number;
  emailed?: boolean;
  error?: string;
}

let lastRun: BackupRunSummary | null = null;
export function lastBackupRun(): BackupRunSummary | null { return lastRun; }

export function backupDir(): string {
  return path.resolve(config.BACKUP_DIR);
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
}

export interface StoredBackup {
  filename: string;
  bytes: number;
  createdAt: string;
}

/** What is on disk right now, newest first. */
export async function listStoredBackups(): Promise<StoredBackup[]> {
  const dir = backupDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: StoredBackup[] = [];
  for (const name of names) {
    if (!name.startsWith('opsflow-') || !name.endsWith('.json.gz')) continue;
    try {
      const st = await fs.stat(path.join(dir, name));
      out.push({ filename: name, bytes: st.size, createdAt: st.mtime.toISOString() });
    } catch { /* vanished between readdir and stat — not worth failing over */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Delete all but the newest `keep` backups.
 *
 * Retention is by count rather than age on purpose: a machine that has been
 * down for a month should still have its last backups when it comes back,
 * which an age-based rule would have deleted.
 */
async function prune(keep: number): Promise<void> {
  const stored = await listStoredBackups();
  for (const old of stored.slice(keep)) {
    await fs.unlink(path.join(backupDir(), old.filename)).catch(() => {});
  }
}

/** Where a copy of each backup is sent, falling back to the super admins. */
export function backupRecipients(): readonly string[] {
  const explicit = parseEmailList(config.BACKUP_EMAIL_TO);
  return explicit.length > 0 ? explicit : SUPER_ADMIN_EMAILS;
}

/**
 * Take one backup: dump, write to disk, prune, and mail a copy out.
 *
 * Returns the summary rather than throwing, because both callers — the timer
 * and the admin endpoint — want to report a failure, not crash on one.
 */
export async function runBackup(): Promise<BackupRunSummary> {
  const at = new Date();
  try {
    const { buffer, meta } = await createBackup();
    const counts = meta.counts;
    const rows = Object.values(counts).reduce((a, b) => a + b, 0);
    const tableCount = Object.keys(counts).length;
    const filename = `opsflow-${stamp(at)}.json.gz`;

    const dir = backupDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), buffer);
    await prune(config.BACKUP_RETAIN);

    let emailed = false;
    const to = backupRecipients();
    if (config.BACKUP_EMAIL_ENABLED && isGraphConfigured() && to.length > 0) {
      // Base64 inflates by a third and Graph's inline-attachment ceiling is
      // around 4 MB. Past that the backup still exists on disk and the email
      // says so, which is better than an exception and no email at all.
      const tooBig = buffer.byteLength * 1.4 > config.BACKUP_EMAIL_MAX_BYTES;
      const summary = describeBackup(counts);
      const size = `${(buffer.byteLength / 1024).toFixed(1)} KB`;
      const body = tooBig
        ? `<p>A backup was taken but is too large to attach (${size}).</p>`
          + `<p>It is on the server as <code>${filename}</code>. Download it from`
          + ` Administration → Backups.</p><p>${summary}</p>`
        : `<p>Automatic OpsFlow database backup, attached.</p>`
          + `<p><strong>${filename}</strong> — ${size}</p><p>${summary}</p>`
          + `<p>Keep this message. Restoring from it returns the system to this moment.</p>`;
      await sendMail({
        to,
        subject: `OpsFlow backup — ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        html: body,
        text: `OpsFlow backup ${filename} (${size}). ${summary}`,
        attachments: tooBig ? [] : [{
          filename, contentType: 'application/gzip', content: buffer,
        }],
      });
      emailed = !tooBig;
    }

    lastRun = {
      at: at.toISOString(), ok: true, filename,
      bytes: buffer.byteLength, rows, tables: tableCount, emailed,
    };
    console.log(`[backup] ${filename} — ${rows} rows, ${tableCount} tables`
      + `, ${(buffer.byteLength / 1024).toFixed(1)} KB${emailed ? ', emailed' : ''}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    lastRun = { at: at.toISOString(), ok: false, error };
    console.error('[backup] failed:', error);
  }
  return lastRun;
}

export function startBackupWorker(): void {
  if (timer || !config.BACKUP_ENABLED) return;
  const everyMs = config.BACKUP_INTERVAL_HOURS * 3600_000;

  const tick = (): void => {
    // A dump holds one transaction open; overlapping runs on a slow database
    // would queue up behind each other for no benefit.
    if (running) return;
    running = true;
    void runBackup().finally(() => { running = false; });
  };

  // One at boot, so a fresh deploy has a restore point immediately rather than
  // an interval later — which is exactly the window a bad deploy lands in.
  setTimeout(tick, config.BACKUP_STARTUP_DELAY_SECONDS * 1000).unref();
  timer = setInterval(tick, everyMs);
  timer.unref();
  console.log(`[backup] every ${config.BACKUP_INTERVAL_HOURS}h → ${backupDir()}`
    + `${config.BACKUP_EMAIL_ENABLED ? ` + email to ${backupRecipients().length} recipient(s)` : ''}`);
}

export function stopBackupWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
