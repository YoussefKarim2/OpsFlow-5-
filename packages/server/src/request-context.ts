import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';

/**
 * Per-request context, so the audit middleware knows who made a change without
 * every service function taking an `actor` parameter it does not otherwise use.
 *
 * It also carries the request's **change collector**. That is the whole
 * mechanism behind "one user action produces one notification and one email":
 * the audit middleware pushes a draft here as each write happens, and the
 * change service turns the whole collection into a single event once the
 * response has gone out successfully. Grouping by request rather than by field
 * is what makes three edited columns into one message instead of three, with no
 * bookkeeping in any route handler.
 */

/** One recorded change, as the audit middleware sees it. */
export interface ChangeDraft {
  model: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  entityId: string;
  orderId: string | null;
  /** Raw column name and raw serialised values. Labelling happens later. */
  field: string;
  oldValue: string | null;
  newValue: string | null;
  /** Enough of the row to name it: a PO number, a material name. */
  subjectHint: string | null;
}

export interface RequestContext {
  userId: string | null;
  userName: string;
  /** Populated from an `X-Change-Reason` header on privileged overrides. */
  reason: string | null;
  requestId: string;
  /** Collected during the request, flushed after it succeeds. */
  changes: ChangeDraft[];
  /**
   * Set by a service that wants this request's changes left alone — an import
   * that creates two hundred rows should not fire two hundred notifications.
   */
  suppressChangeEvents: boolean;
  /**
   * Who is asking, for the order-access filter.
   *
   * Null means the system rather than a person — the alert sweep, the seed, a
   * job — and those are not filtered. Kept here rather than read from Express
   * because the filter runs inside Prisma middleware, which has no request.
   */
  accessActor: { id: string; isSuperAdmin: boolean; permissions: readonly string[] } | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Record a change for this request. No-op outside a request. */
export function collectChange(draft: ChangeDraft): void {
  const ctx = storage.getStore();
  if (!ctx || ctx.suppressChangeEvents) return;
  ctx.changes.push(draft);
}

/**
 * Ask for this request's changes to be recorded in the audit trail but not
 * announced. Used by the Excel importer, where the news is "an order was
 * imported", not four hundred individual inserts.
 */
export function suppressChangeEvents(): void {
  const ctx = storage.getStore();
  if (ctx) ctx.suppressChangeEvents = true;
}

function newContext(req?: Request): RequestContext {
  return {
    userId: req?.user?.id ?? null,
    userName: req?.user?.name ?? 'Anonymous',
    reason: (req?.headers['x-change-reason'] as string) || null,
    requestId: (req?.headers['x-request-id'] as string) || crypto.randomUUID(),
    changes: [],
    suppressChangeEvents: false,
    accessActor: req?.user
      ? {
          id: req.user.id,
          isSuperAdmin: req.user.isSuperAdmin,
          permissions: req.user.permissions,
        }
      : null,
  };
}

/**
 * Called after the response has been sent, with whatever the request collected.
 * Injected rather than imported so this module keeps no dependency on the
 * database or the notification system — it is plumbing, not policy.
 */
export type ChangeFlusher = (ctx: RequestContext) => void;

let flusher: ChangeFlusher | null = null;

export function setChangeFlusher(fn: ChangeFlusher | null): void {
  flusher = fn;
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ctx = newContext(req);

  // `finish` fires once the response has actually gone to the client, so
  // nothing here can delay a reply. The context is captured by closure rather
  // than read from AsyncLocalStorage, because the listener runs on a later
  // tick and must not depend on the store still being entered.
  res.on('finish', () => {
    if (ctx.changes.length === 0) return;
    // A failed request may still have committed some writes; those belong in
    // the audit trail (they already are) but announcing them as news would tell
    // people about work that did not happen.
    if (res.statusCode >= 400) return;
    // GET, HEAD and OPTIONS never produce a change event. A read that somehow
    // wrote something is a bug worth finding in the audit trail, not an email.
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    try {
      flusher?.(ctx);
    } catch (err) {
      // Announcing a change must never be able to affect the change itself.
      console.error('CHANGE FLUSH FAILED — the change was saved but not announced:', err);
    }
  });

  storage.run(ctx, () => next());
}

/** Run a block with an explicit actor — used by the seed script and jobs. */
export function withContext<T>(ctx: Partial<RequestContext>, fn: () => Promise<T>): Promise<T> {
  return storage.run({ ...newContext(), ...ctx }, fn);
}
