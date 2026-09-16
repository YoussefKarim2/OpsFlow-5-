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

  /**
   * Express decodes route parameters with `decodeURIComponent`, which throws on
   * a truncated escape — a link cut short in an email, or a hand-edited
   * address. That is the caller's URL, not the server failing.
   */
  test('a URL the router cannot decode is the caller\'s fault, not a 500', async () => {
    for (const path of ['/api/orders/%E0%A4%A', '/api/orders/%', '/api/orders/%zz']) {
      const res = await fetch(`${base}${path}`);
      assert.ok(res.status < 500, `${path} returned ${res.status}`);
      if (res.status === 400) {
        const body = await res.json() as { code?: string; error?: string };
        assert.equal(body.code, 'MALFORMED_URL');
        assert.doesNotMatch(body.error ?? '', /URIError|decodeURIComponent|at /);
      }
    }
  });

  /**
   * A quantity past what a 32-bit column holds, and a date that is not one.
   * Both used to reach Postgres and come back as 500s — the caller told the
   * server had broken when they had typed too many digits, or a bad date.
   */
  test('a quantity larger than the column holds is refused as input', async () => {
    const { assertValidQuantity } = await import('./services/rules.js');
    assert.throws(() => assertValidQuantity(1e12), /larger than this system records/);
    assert.throws(() => assertValidQuantity(2_147_483_648), /larger than this system records/);
    assert.doesNotThrow(() => assertValidQuantity(1_000_000));
    assert.doesNotThrow(() => assertValidQuantity(0));
  });

  test('a date that cannot be read is refused as input', async () => {
    const { requiredDate } = await import('./util/form-input.js');
    for (const bad of ['not-a-date', '', '2026-13-45', 'yesterday']) {
      assert.equal(requiredDate.safeParse(bad).success, false, `${bad} should be refused`);
    }
    for (const good of ['2026-06-02', '2026-06-02T10:00:00Z']) {
      assert.equal(requiredDate.safeParse(good).success, true, `${good} should be accepted`);
    }
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
