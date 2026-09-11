/**
 * Take one backup right now, outside the schedule.
 *
 *   npm run backup -w @opsflow/server
 *
 * Useful immediately before a migration or a risky deploy.
 */

import { runBackup } from '../services/backup/backup-worker.js';
import { disconnect } from '../db.js';

runBackup()
  .then(async (summary) => {
    await disconnect();
    process.exit(summary.ok ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(err);
    await disconnect();
    process.exit(1);
  });
