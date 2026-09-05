import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config, isProd, TRUST_PROXY } from './config.js';
import { AppError } from './errors.js';
import { requestContextMiddleware, setChangeFlusher } from './request-context.js';
import { authenticate, enforcePasswordChange } from './middleware/auth.js';

import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { ordersRouter } from './routes/orders.js';
import { tasksRouter } from './routes/tasks.js';
import { productionRouter } from './routes/production.js';
import { materialsRouter } from './routes/materials.js';
import { inventoryRouter } from './routes/inventory.js';
import { externalRouter } from './routes/external.js';
import { qualityRouter } from './routes/quality.js';
import { packingRouter } from './routes/packing.js';
import { dashboardRouter } from './routes/dashboard.js';
import { importRouter } from './routes/import.js';
import { layingImportRouter } from './routes/laying-import.js';
import { notificationPreferencesRouter } from './routes/notification-preferences.js';
import { referenceRouter } from './routes/reference.js';
import { stepsRouter } from './routes/steps.js';
import { changesRouter } from './routes/changes.js';
import { flushChanges } from './services/change-service.js';

/**
 * Announce whatever a request changed, once it has finished successfully.
 *
 * Registered here rather than imported by `request-context.ts` so that the
 * context module — which the audit middleware depends on — keeps no dependency
 * on the database or on the notification system. It stays plumbing.
 */
setChangeFlusher(flushChanges);

// Present when `packages/web` has been built alongside this package (a
// combined single-service deploy). Absent in local dev, where Vite serves
// the frontend itself and proxies `/api` here instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
const hasWebBuild = fs.existsSync(path.join(webDist, 'index.html'));

export function createApp() {
  const app = express();

  // Must be set before anything reads `req.ip`. The login rate limiter keys on
  // it, and behind an unconfigured proxy every request appears to come from the
  // same address — turning a per-attacker limit into a company-wide outage.
  app.set('trust proxy', TRUST_PROXY);

  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'opsflow-api', version: '0.1.0', env: config.NODE_ENV });
  });

  app.use('/api/auth', authRouter);

  // Everything past here is authenticated, and every request carries an actor
  // in AsyncLocalStorage so the audit middleware knows who made each change.
  // An account whose password was reset by an administrator gets no further
  // than /auth/me and /auth/change-password until it sets a new one.
  app.use('/api', authenticate, requestContextMiddleware, enforcePasswordChange);

  app.use('/api/admin', adminRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/orders', ordersRouter);
  // The guided step routine, plus the four screens that had no home before it:
  // customer documents, custom instructions, finished stock, proforma invoice.
  app.use('/api/orders', stepsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/production', productionRouter);
  // `/materials` stays the per-order BOM; `/inventory` is the factory's own
  // stock. Two different questions, deliberately two different routers.
  app.use('/api/materials', materialsRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/external', externalRouter);
  app.use('/api/quality', qualityRouter);
  app.use('/api/packing', packingRouter);
  app.use('/api/import', importRouter);
  app.use('/api/orders/:orderId/laying-import', layingImportRouter);
  app.use('/api/notification-preferences', notificationPreferencesRouter);
  app.use('/api/changes', changesRouter);
  app.use('/api', referenceRouter);

  if (hasWebBuild) {
    app.use(express.static(webDist));
    // SPA fallback: any non-API GET that didn't match a static asset gets
    // index.html, so client-side routes (e.g. /orders/123) survive a refresh.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });
  });

  app.use(errorHandler);
  return app;
}

/**
 * One error handler for the whole API.
 *
 * Every business rule in `rules.ts` throws a typed error carrying a stable code
 * and a message written for the person reading it. That message is passed
 * straight through, because "External printing requires customer approval
 * before it can start" is the entire point — a generic 500 would put the
 * coordinator back where the spreadsheet left them.
 */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: 'Some fields are invalid.',
      code: 'VALIDATION_FAILED',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'value';
      res.status(409).json({ error: `That ${target} is already in use.`, code: 'DUPLICATE' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'The record was not found.', code: 'NOT_FOUND' });
      return;
    }
    if (err.code === 'P2003') {
      res.status(409).json({
        error: 'That record is referenced by something else and cannot be changed.',
        code: 'FOREIGN_KEY',
      });
      return;
    }
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: isProd ? 'Something went wrong on our side.' : String(err instanceof Error ? err.stack : err),
    code: 'INTERNAL_ERROR',
  });
}
