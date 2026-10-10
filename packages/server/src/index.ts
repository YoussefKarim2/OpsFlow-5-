import { createApp } from './app.js';
import { config } from './config.js';
import { prisma, disconnect } from './db.js';
import { startEmailWorker, stopEmailWorker } from './services/email/email-queue.js';
import { startAlertWorker, stopAlertWorker } from './services/alerts/alert-worker.js';
import { startBackupWorker, stopBackupWorker } from './services/backup/backup-worker.js';
import { installProcessGuards } from './process-guards.js';
import { reconcileAllStockLedgers } from './services/stock-sync.js';
import { refreshOrderCache } from './services/order-service.js';

async function main(): Promise<void> {
  await prisma.$connect();

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(`OpsFlow API listening on http://localhost:${config.PORT}`);
    console.log(`  health   → http://localhost:${config.PORT}/api/health`);
    console.log(`  env      → ${config.NODE_ENV}`);
    console.log(`  storage  → ${config.STORAGE_DRIVER}`);
    // Started here rather than in createApp() so that building an app for a
    // test never starts a timer or touches the network.
    startEmailWorker();
    startAlertWorker();
    startBackupWorker();

    // Finished stock recorded before the Stock step and the quantity ledger
    // were connected never reached the cut order. Settling those orders is a
    // one-off that costs nothing once done, and it runs after the server is
    // already listening so it cannot delay a health check.
    void reconcileAllStockLedgers()
      .then(({ scanned, corrected }) => {
        if (corrected > 0) console.log(`  stock    → reconciled ${corrected} of ${scanned} orders with recorded stock`);
      })
      .catch((err) => console.error('[stock] reconcile failed:', err));

    // Customer approvals were removed, but an order whose cached status was
    // saved as WAITING_APPROVAL before that keeps showing it until something
    // recalculates it. Recalculate those once. The cache is derived from the
    // order's own records, so this changes no business data; once none are
    // left it is one empty query.
    void prisma.order.findMany({ where: { cachedStatus: 'WAITING_APPROVAL' as never }, select: { id: true } })
      .then(async (stale) => {
        for (const o of stale) await refreshOrderCache(o.id);
        if (stale.length > 0) console.log(`  orders   → recalculated ${stale.length} order status(es) left at "waiting for approval"`);
      })
      .catch((err) => console.error('[orders] approval status refresh failed:', err));
  });

  let shuttingDown = false;
  const shutdown = (signal: string, code = 0): void => {
    // A SIGTERM arriving during an uncaughtException shutdown must not start a
    // second one; the first is already draining.
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down.`);
    stopEmailWorker();
    stopAlertWorker();
    stopBackupWorker();
    server.close(async () => {
      await disconnect().catch(() => {});
      process.exit(code);
    });
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(code || 1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  installProcessGuards({ shutdown: (reason) => shutdown(reason, 1) });
}

main().catch(async (err) => {
  console.error('Failed to start:', err);
  await disconnect().catch(() => {});
  process.exit(1);
});
