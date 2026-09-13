import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './app.js';

/**
 * What the API does with a request that is malformed rather than merely wrong.
 *
 * `express.json()` throws a SyntaxError for a body that is not JSON, and that
 * is none of the error shapes the handler recognised — so it fell through to
 * the 500 branch. The caller was told the server had broken when the request
 * had, and every malformed request was logged as "Unhandled error", which is
 * the noise that buries the failures that really are ours.
 */
describe('a request the server cannot parse', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  after(() => { server.close(); });

  test('a body that is not JSON is the caller\'s fault, not a 500', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { code?: string };
    assert.equal(body.code, 'MALFORMED_JSON');
  });

  test('an empty body is refused the same way', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '<<<',
    });
    assert.equal(res.status, 400);
  });
});
