import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './app.js';

/**
 * The security policy the browser is actually sent.
 *
 * This is here because of a bug that looked nothing like a security setting.
 * Attachments are fetched with a bearer token and reach the browser as blob:
 * URLs, and the stock policy — `img-src 'self' data:` — silently refused to
 * render every one of them. The file downloaded, the browser dropped it, and
 * the user saw "I can see the file but I cannot open it".
 *
 * Asserted in both directions: blob: must be allowed where a document is
 * displayed, and must never be allowed where code is executed.
 */
describe('the content security policy sent to browsers', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  after(() => { server.close(); });

  const policy = async (): Promise<Record<string, string>> => {
    const res = await fetch(`${base}/api/health`);
    const header = res.headers.get('content-security-policy') ?? '';
    return Object.fromEntries(
      header.split(';').map((d) => d.trim()).filter(Boolean)
        .map((d) => [d.split(/\s+/)[0]!, d]),
    );
  };

  test('a file held in the page can be displayed', async () => {
    const p = await policy();
    for (const directive of ['img-src', 'object-src', 'frame-src', 'media-src']) {
      assert.match(
        p[directive] ?? '', /blob:/,
        `${directive} must allow blob:, or attachments cannot be opened`,
      );
    }
  });

  test('a file held in the page can never be executed as code', async () => {
    const p = await policy();
    assert.doesNotMatch(p['script-src'] ?? '', /blob:/, 'script-src must not allow blob:');
    assert.match(p['script-src'] ?? '', /'self'/);
  });

  test('the policy is still closed by default', async () => {
    // Widening one directive must not have opened everything.
    const p = await policy();
    assert.equal(p['default-src'], "default-src 'self'");
  });
});
