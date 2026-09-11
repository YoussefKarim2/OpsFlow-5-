/**
 * Restore the database from a backup file.
 *
 *   npm run restore -w @opsflow/server -- ./.backups/opsflow-....json.gz --yes
 *
 * This replaces every row in every table the backup covers. It refuses to run
 * without `--yes`, because the one thing worse than losing the database is
 * overwriting a good one with an old copy by tab-completing the wrong command.
 */

import { promises as fs } from 'node:fs';
import { readBackup, describeBackup } from '../services/backup/backup-service.js';
import { restoreBackup } from '../services/backup/restore.js';
import { disconnect } from '../db.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const confirmed = args.includes('--yes');

  if (!file) {
    console.error('Usage: restore-backup <file.json.gz> --yes');
    process.exit(2);
  }

  const buffer = await fs.readFile(file);
  const payload = readBackup(buffer);
  console.log(`Backup taken ${payload.takenAt}`);
  console.log(`  ${describeBackup(payload.counts)}`);

  if (!confirmed) {
    console.error('\nThis REPLACES every row in the target database.');
    console.error('Re-run with --yes if that is what you want.');
    process.exit(1);
  }

  const result = await restoreBackup(buffer);
  console.log(`Restored ${result.rows.toLocaleString()} rows across ${result.tables} tables.`);
  if (result.skipped.length > 0) {
    console.log(`Skipped (not in this schema): ${result.skipped.join(', ')}`);
  }
}

main()
  .then(() => disconnect())
  .catch(async (err) => {
    console.error('Restore failed:', err instanceof Error ? err.message : err);
    await disconnect();
    process.exit(1);
  });
