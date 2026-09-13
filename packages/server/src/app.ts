import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { config, isProd, TRUST_PROXY } from './config.js';
import { AppError } from './errors.js';
import { requestContextMiddleware, setChangeFlusher } from './request-context.js';
import { authenticate, enforcePasswordChange } from './middleware/auth.js';

import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
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

  /**
   * Helmet's defaults, with one deliberate widening: `blob:`.
   *
   * Attachments are fetched with the bearer token the rest of the app uses —
   * an <img src> or an <a href> cannot carry an Authorization header — and the
   * bytes then reach the browser as a blob: URL. Under the stock policy
   * (`default-src 'self'`, `img-src 'self' data:`) every one of those was
   * blocked: the file downloaded correctly and the browser then refused to
   * display it, which looked exactly like "I can see the file but cannot open
   * it".
   *
   * blob: is not a network origin. It addresses bytes this page already holds,
   * created by this page, readable by nobody else — so allowing it grants no
   * new reach to an attacker. `default-src` stays 'self', and each directive
   * that can actually render a file is widened on its own rather than opening
   * the policy wholesale. `script-src` is pointedly not among them: a blob is
   * a document to look at, never code to run.
   */
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'object-src': ["'self'", 'blob:'],
        'frame-src': ["'self'", 'blob:'],
      },
    },
  }));
  app.use(cors({ origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  /**
   * Liveness — is this process answering at all?
   *
   * Deliberately touches nothing: no database, no disk. This is what the
   * platform's healthcheck watches, and it must fail only when the process
   * really is wedged. If it pinged the database, a thirty-second database
   * blip would be read as "the API is broken", and the platform would restart
   * a perfectly healthy container — repeatedly, during exactly the incident
   * when a restart helps least.
   */
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true, service: 'opsflow-api', version: '0.1.0', env: config.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  /**
   * Readiness — can this process actually do its job?
   *
   * Pings the database, so a 503 here means "up, but not serving". Useful to a
   * human diagnosing an outage and to a load balancer deciding where to send
   * traffic; not wired to anything that restarts the container.
   */
  app.get('/api/health/ready', (_req, res) => {
    void prisma.$queryRaw`SELECT 1`.then(
      () => res.json({ ok: true, database: 'up' }),
      (err: unknown) => res.status(503).json({
        ok: false,
        database: 'down',
        error: err instanceof Error ? err.message : 'unreachable',
      }),
    );
  });

  app.use('/api/auth', authRouter);

  // Before the authenticated block on purpose: this is the one route the
  // browser reaches as a link or an <img>, where it cannot send a header. It
  // authenticates itself — a bearer token, or the signed link in `?t=`.
  app.use('/api/files', filesRouter);

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

  /**
   * A body that is not JSON.
   *
   * `express.json()` throws a SyntaxError, which is none of the shapes below,
   * so it fell through to the 500 branch: the caller was told the server had
   * broken when in fact the request had, and every malformed request was
   * logged as "Unhandled error" — noise that buries the failures that really
   * are ours.
   */
  if (err instanceof SyntaxError && 'body' in (err as { body?: unknown })) {
    res.status(400).json({
      error: 'The request body was not valid JSON.',
      code: 'MALFORMED_JSON',
    });
    return;
  }

  /**
   * An upload that broke a multer limit.
   *
   * Multer throws its own `MulterError`, which was none of the shapes below, so
   * a file one megabyte over the limit came back as "Something went wrong on
   * our side" — the user is told the server is broken when their file is
   * simply too big, and has no idea what to do about it. The limit is a rule we
   * chose, so the message should say so.
   */
  if (err instanceof Error && err.name === 'MulterError') {
    const code = (err as Error & { code?: string }).code;
    const message =
      code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large. The limit is 20 MB — try a smaller copy, or split it.'
        : code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Please upload one file at a time.'
          : 'That file could not be accepted.';
    res.status(413).json({ error: message, code: 'UPLOAD_REJECTED' });
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
