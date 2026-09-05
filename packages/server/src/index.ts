import { createApp } from './app.js';
import { config } from './config.js';
import { prisma, disconnect } from './db.js';
import { startEmailWorker, stopEmailWorker } from './services/email/email-queue.js';
import { startAlertWorker, stopAlertWorker } from './services/alerts/alert-worker.js';

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
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down.`);
    stopEmailWorker();
    stopAlertWorker();
    server.close(async () => {
      await disconnect();
      process.exit(0);
    });
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (err) => {
  console.error('Failed to start:', err);
  await disconnect();
  process.exit(1);
});
