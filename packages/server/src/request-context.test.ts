/**
 * Who made the change, and when a change is announced at all.
 *
 * The two guarantees this file exists to hold:
 *
 * **The actor comes from the session, never from the request body.** A client
 * that posts `{"changedBy": "Ahmed"}` must be recorded as whoever their token
 * says they are. The middleware reads `req.user`, which `authenticate` set from
 * a verified JWT and a fresh database lookup, and there is no code path from
 * the body to the context.
 *
 * **Reads never announce anything.** Opening an order, searching, filtering —
 * none of them produce a change event, even if something downstream wrote a
 * cache column.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import {
  requestContextMiddleware, getRequestContext, collectChange,
  suppressChangeEvents, setChangeFlusher, withContext,
  type RequestContext, type ChangeDraft,
} from './request-context.js';

/** A request/response pair good enough for the middleware. */
function fakeReqRes(over: {
  method?: string;
  user?: { id: string; name: string } | undefined;
  headers?: Record<string, string>;
  statusCode?: number;
} = {}) {
  const req = {
    method: over.method ?? 'POST',
    user: over.user,
    headers: over.headers ?? {},
    // Anything a hostile client might send. Nothing reads it.
    body: { changedBy: 'Ahmed', actorId: 'someone-else', userName: 'Not Me' },
  } as unknown as Request;

  const res = Object.assign(new EventEmitter(), {
    statusCode: over.statusCode ?? 200,
  }) as unknown as Response & EventEmitter;

  return { req, res };
}

const draft = (over: Partial<ChangeDraft> = {}): ChangeDraft => ({
  model: 'Order', action: 'UPDATE', entityId: 'o1', orderId: 'o1',
  field: 'orderName', oldValue: 'A', newValue: 'B', subjectHint: null, ...over,
});

let flushed: RequestContext[] = [];
beforeEach(() => {
  flushed = [];
  setChangeFlusher((ctx) => { flushed.push(ctx); });
});

describe('the frontend cannot say who made a change', () => {
  test('the actor is the authenticated user, whatever the body claims', () => {
    const { req, res } = fakeReqRes({ user: { id: 'user-real', name: 'Youssef Karim' } });

    requestContextMiddleware(req, res, () => {
      const ctx = getRequestContext()!;
      assert.equal(ctx.userId, 'user-real');
      assert.equal(ctx.userName, 'Youssef Karim');
      // The body said "Ahmed". It is not anywhere in the context.
      assert.ok(!JSON.stringify(ctx).includes('Ahmed'));
      assert.ok(!JSON.stringify(ctx).includes('someone-else'));
    });
  });

  test('an unauthenticated request is Anonymous, not whatever it asked to be', () => {
    const { req, res } = fakeReqRes({ user: undefined });
    requestContextMiddleware(req, res, () => {
      const ctx = getRequestContext()!;
      assert.equal(ctx.userId, null);
      assert.equal(ctx.userName, 'Anonymous');
    });
  });

  test('the change reason comes from a header, and is carried through', () => {
    const { req, res } = fakeReqRes({
      user: { id: 'u1', name: 'A' },
      headers: { 'x-change-reason': 'Customer moved the date' },
    });
    requestContextMiddleware(req, res, () => {
      assert.equal(getRequestContext()!.reason, 'Customer moved the date');
    });
  });
});

describe('one request, one flush', () => {
  test('everything collected during a request arrives together', () => {
    const { req, res } = fakeReqRes({ user: { id: 'u1', name: 'Youssef' } });

    requestContextMiddleware(req, res, () => {
      collectChange(draft({ field: 'qty', oldValue: '300', newValue: '350' }));
      collectChange(draft({ field: 'requiredDeliveryDate', oldValue: 'a', newValue: 'b' }));
      collectChange(draft({ field: 'coordinatorId', oldValue: 'x', newValue: 'y' }));
    });
    res.emit('finish');

    assert.equal(flushed.length, 1, 'one flush per request, not one per change');
    assert.equal(flushed[0]!.changes.length, 3);
    assert.equal(flushed[0]!.userName, 'Youssef');
  });

  test('a request that changed nothing flushes nothing', () => {
    const { req, res } = fakeReqRes({ user: { id: 'u1', name: 'A' } });
    requestContextMiddleware(req, res, () => { /* a request that only reads */ });
    res.emit('finish');
    assert.equal(flushed.length, 0);
  });
});

describe('reads never announce anything', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    test(`${method} produces no change event even if something wrote`, () => {
      const { req, res } = fakeReqRes({ method, user: { id: 'u1', name: 'A' } });
      requestContextMiddleware(req, res, () => {
        // A read path that touches a cache column, say. It belongs in the audit
        // trail; it is not news, and nobody should be emailed about it.
        collectChange(draft({ field: 'cachedProgressPct', oldValue: '30', newValue: '36' }));
      });
      res.emit('finish');
      assert.equal(flushed.length, 0);
    });
  }
});

describe('a failed request does not announce work that did not happen', () => {
  for (const status of [400, 403, 409, 422, 500]) {
    test(`HTTP ${status} announces nothing`, () => {
      const { req, res } = fakeReqRes({ user: { id: 'u1', name: 'A' }, statusCode: status });
      requestContextMiddleware(req, res, () => {
        collectChange(draft());
      });
      res.emit('finish');
      assert.equal(flushed.length, 0, 'the audit trail keeps it; the factory is not told');
    });
  }

  test('a 201 does announce — creating something is a success', () => {
    const { req, res } = fakeReqRes({ user: { id: 'u1', name: 'A' }, statusCode: 201 });
    requestContextMiddleware(req, res, () => { collectChange(draft({ action: 'CREATE' })); });
    res.emit('finish');
    assert.equal(flushed.length, 1);
  });
});

describe('bulk operations can ask not to be announced row by row', () => {
  test('suppression stops collection entirely', () => {
    const { req, res } = fakeReqRes({ user: { id: 'u1', name: 'A' } });
    requestContextMiddleware(req, res, () => {
      suppressChangeEvents();
      // An import writing four hundred rows.
      for (let i = 0; i < 400; i++) collectChange(draft({ entityId: `row-${i}` }));
    });
    res.emit('finish');
    assert.equal(flushed.length, 0, 'the importer announces once, itself');
  });
});

describe('announcing can never break the request it describes', () => {
  test('a flusher that throws is caught, not propagated', () => {
    setChangeFlusher(() => { throw new Error('the notification system is on fire'); });
    const { req, res } = fakeReqRes({ user: { id: 'u1', name: 'A' } });

    requestContextMiddleware(req, res, () => { collectChange(draft()); });
    // The order is already saved and the response already sent. This must not
    // become an unhandled exception on the way out.
    assert.doesNotThrow(() => res.emit('finish'));
  });
});

describe('outside a request', () => {
  test('collecting a change is a no-op rather than a crash', () => {
    // A background job or the seed script writing without a request context.
    assert.doesNotThrow(() => collectChange(draft()));
    assert.equal(getRequestContext(), undefined);
  });

  test('withContext gives a job an explicit actor', async () => {
    await withContext({ userId: 'job', userName: 'Nightly job' }, async () => {
      const ctx = getRequestContext()!;
      assert.equal(ctx.userName, 'Nightly job');
      assert.deepEqual(ctx.changes, []);
    });
  });
});
