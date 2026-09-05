/**
 * The Microsoft Graph mailer.
 *
 * Every test here stubs `fetch`. Nothing in the suite talks to Microsoft, and
 * nothing needs a tenant to run — but the shape of both requests is asserted
 * exactly, because the two ways this fails in production are a malformed token
 * request (which looks like bad credentials) and recipients in the wrong field
 * (which looks like it worked, and publishes the whole factory's addresses to
 * the whole factory).
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  sendMail, getAccessToken, resetTokenCache, summariseError,
  GraphNotConfiguredError, GraphSendError, missingGraphConfig,
} from './graph-mailer.js';
import { config } from '../../config.js';

/** A fetch that records what it was asked and answers from a script. */
function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const TOKEN_OK = { status: 200, body: { access_token: 'test-token', expires_in: 3600 } };

/**
 * The settings are read from `config`, which is frozen at import. These tests
 * write onto it directly rather than re-importing the module per case — the
 * alternative is a module-cache dance that tests the dance, not the mailer.
 */
const writable = config as unknown as Record<string, unknown>;

function withCredentials(fn: () => void | Promise<void>) {
  const saved = {
    t: writable.MICROSOFT_TENANT_ID, c: writable.MICROSOFT_CLIENT_ID,
    s: writable.MICROSOFT_CLIENT_SECRET, e: writable.MICROSOFT_SENDER_EMAIL,
  };
  writable.MICROSOFT_TENANT_ID = 'tenant-123';
  writable.MICROSOFT_CLIENT_ID = 'client-456';
  writable.MICROSOFT_CLIENT_SECRET = 'secret-789';
  writable.MICROSOFT_SENDER_EMAIL = 'opsflow@example.com';
  const restore = () => {
    writable.MICROSOFT_TENANT_ID = saved.t;
    writable.MICROSOFT_CLIENT_ID = saved.c;
    writable.MICROSOFT_CLIENT_SECRET = saved.s;
    writable.MICROSOFT_SENDER_EMAIL = saved.e;
  };
  const out = fn();
  return out instanceof Promise ? out.finally(restore) : (restore(), out);
}

/**
 * The mirror image: run `fn` with the four settings explicitly absent.
 *
 * Needed for the same reason `withCredentials` is. `config` is parsed from the
 * real `.env` at import, so on any machine where Microsoft 365 is actually
 * configured — which is every machine that has finished setting it up — the
 * "unconfigured" case was silently testing a configured one, and the assertion
 * that it rejects failed. A test must not depend on a setting being blank in
 * the developer's environment.
 */
function withoutCredentials(fn: () => void | Promise<void>) {
  const saved = {
    t: writable.MICROSOFT_TENANT_ID, c: writable.MICROSOFT_CLIENT_ID,
    s: writable.MICROSOFT_CLIENT_SECRET, e: writable.MICROSOFT_SENDER_EMAIL,
  };
  writable.MICROSOFT_TENANT_ID = undefined;
  writable.MICROSOFT_CLIENT_ID = undefined;
  writable.MICROSOFT_CLIENT_SECRET = undefined;
  writable.MICROSOFT_SENDER_EMAIL = undefined;
  const restore = () => {
    writable.MICROSOFT_TENANT_ID = saved.t;
    writable.MICROSOFT_CLIENT_ID = saved.c;
    writable.MICROSOFT_CLIENT_SECRET = saved.s;
    writable.MICROSOFT_SENDER_EMAIL = saved.e;
  };
  const out = fn();
  return out instanceof Promise ? out.finally(restore) : (restore(), out);
}

beforeEach(() => resetTokenCache());

describe('configuration is checked before anything is attempted', () => {
  test('an unconfigured system says exactly what is missing', async () => {
    await withoutCredentials(async () => {
      const { fetcher, calls } = stubFetch([TOKEN_OK]);
      await assert.rejects(
        () => sendMail({ to: ['a@b.com'], subject: 's', html: 'h', text: 't' }, fetcher),
        (err: Error) => {
          assert.ok(err instanceof GraphNotConfiguredError);
          assert.match(err.message, /MICROSOFT_TENANT_ID/);
          // It must also say the factory keeps working, because that is true and
          // is the first thing somebody reading this error needs to know.
          assert.match(err.message, /works fully without this/);
          return true;
        },
      );
      assert.equal(calls.length, 0, 'nothing should be sent before the settings exist');
    });
  });

  test('missingGraphConfig names every absent setting, and no present one', () => {
    const missing = missingGraphConfig();
    // Whatever the environment, it never reports a *value* — only a name.
    for (const name of missing) assert.match(name, /^MICROSOFT_[A-Z_]+$/);
  });
});

describe('the token request', () => {
  test('uses client credentials and the .default scope', async () => {
    await withCredentials(async () => {
      const { fetcher, calls } = stubFetch([TOKEN_OK]);
      const token = await getAccessToken(fetcher);

      assert.equal(token, 'test-token');
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0]!.url,
        'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token',
      );

      const body = new URLSearchParams(String(calls[0]!.init.body));
      assert.equal(body.get('grant_type'), 'client_credentials');
      // Asking for Mail.Send here instead is the classic mistake: consent for
      // application permissions is granted in Entra, not requested per call.
      assert.equal(body.get('scope'), 'https://graph.microsoft.com/.default');
      assert.equal(body.get('client_id'), 'client-456');
    });
  });

  test('is cached, so a burst of changes is one token not twenty', async () => {
    await withCredentials(async () => {
      const { fetcher, calls } = stubFetch([TOKEN_OK, { status: 202, body: '' }]);
      await getAccessToken(fetcher);
      await getAccessToken(fetcher);
      await getAccessToken(fetcher);
      assert.equal(calls.length, 1);
    });
  });

  test('a token that expires immediately is not cached into a 401 loop', async () => {
    await withCredentials(async () => {
      const { fetcher, calls } = stubFetch([
        { status: 200, body: { access_token: 'short', expires_in: 10 } },
      ]);
      await getAccessToken(fetcher);
      await getAccessToken(fetcher);
      // Ten seconds is inside the 60-second safety margin, so it is refetched.
      assert.equal(calls.length, 2);
    });
  });

  test('a rejected token request explains itself', async () => {
    await withCredentials(async () => {
      const { fetcher } = stubFetch([{
        status: 401,
        body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret.' },
      }]);
      await assert.rejects(
        () => getAccessToken(fetcher),
        (err: Error) => {
          assert.ok(err instanceof GraphSendError);
          assert.match(err.message, /Invalid client secret/);
          return true;
        },
      );
    });
  });
});

describe('the send', () => {
  test('recipients go in Bcc, so the factory’s addresses stay private', async () => {
    await withCredentials(async () => {
      const { fetcher, calls } = stubFetch([TOKEN_OK, { status: 202, body: '' }]);
      await sendMail(
        { to: ['a@f.com', 'b@f.com', 'c@f.com'], subject: 'S', html: '<p>H</p>', text: 'T' },
        fetcher,
      );

      const send = calls[1]!;
      assert.equal(send.url, 'https://graph.microsoft.com/v1.0/users/opsflow%40example.com/sendMail');

      const payload = JSON.parse(String(send.init.body)) as {
        message: {
          subject: string;
          body: { contentType: string; content: string };
          toRecipients: Array<{ emailAddress: { address: string } }>;
          bccRecipients: Array<{ emailAddress: { address: string } }>;
        };
      };

      assert.equal(payload.message.subject, 'S');
      assert.equal(payload.message.body.contentType, 'HTML');
      assert.deepEqual(
        payload.message.bccRecipients.map((r) => r.emailAddress.address),
        ['a@f.com', 'b@f.com', 'c@f.com'],
      );
      // Nobody's address is visible to anybody else.
      assert.deepEqual(
        payload.message.toRecipients.map((r) => r.emailAddress.address),
        ['opsflow@example.com'],
      );
    });
  });

  test('is one call for many people, not one per person', async () => {
    await withCredentials(async () => {
      const { fetcher, calls } = stubFetch([TOKEN_OK, { status: 202, body: '' }]);
      const many = Array.from({ length: 40 }, (_, i) => `user${i}@f.com`);
      await sendMail({ to: many, subject: 'S', html: 'H', text: 'T' }, fetcher);
      assert.equal(calls.length, 2, 'one token, one send — Graph throttles the alternative');
    });
  });

  test('duplicate and differently-cased addresses collapse', async () => {
    await withCredentials(async () => {
      const { fetcher, calls } = stubFetch([TOKEN_OK, { status: 202, body: '' }]);
      await sendMail(
        { to: ['A@F.com', 'a@f.com', ' a@f.com '], subject: 'S', html: 'H', text: 'T' },
        fetcher,
      );
      const payload = JSON.parse(String(calls[1]!.init.body)) as {
        message: { bccRecipients: unknown[] };
      };
      assert.equal(payload.message.bccRecipients.length, 1);
    });
  });

  test('nobody to send to is not an error, and is not a request', async () => {
    await withCredentials(async () => {
      const { fetcher, calls } = stubFetch([TOKEN_OK]);
      await sendMail({ to: [], subject: 'S', html: 'H', text: 'T' }, fetcher);
      assert.equal(calls.length, 0);
    });
  });

  test('202 Accepted is success — Graph returns no body', async () => {
    await withCredentials(async () => {
      const { fetcher } = stubFetch([TOKEN_OK, { status: 202, body: '' }]);
      await sendMail({ to: ['a@f.com'], subject: 'S', html: 'H', text: 'T' }, fetcher);
    });
  });

  test('a refusal names the Graph error rather than the raw body', async () => {
    await withCredentials(async () => {
      const { fetcher } = stubFetch([TOKEN_OK, {
        status: 403,
        body: { error: { code: 'ErrorAccessDenied', message: 'Access to OData is disabled.' } },
      }]);
      await assert.rejects(
        () => sendMail({ to: ['a@f.com'], subject: 'S', html: 'H', text: 'T' }, fetcher),
        (err: Error) => {
          assert.ok(err instanceof GraphSendError);
          assert.match(err.message, /ErrorAccessDenied/);
          assert.match(err.message, /HTTP 403/);
          return true;
        },
      );
    });
  });

  test('a 401 drops the cached token, so the retry does not reuse a dead one', async () => {
    await withCredentials(async () => {
      const first = stubFetch([TOKEN_OK, { status: 401, body: { error: { message: 'expired' } } }]);
      await assert.rejects(() =>
        sendMail({ to: ['a@f.com'], subject: 'S', html: 'H', text: 'T' }, first.fetcher));

      const second = stubFetch([TOKEN_OK, { status: 202, body: '' }]);
      await sendMail({ to: ['a@f.com'], subject: 'S', html: 'H', text: 'T' }, second.fetcher);
      assert.equal(second.calls.length, 2, 'a fresh token was fetched, not reused');
    });
  });
});

describe('errors are summarised into something worth logging', () => {
  test('a Graph error object becomes code and message', () => {
    assert.equal(
      summariseError(JSON.stringify({ error: { code: 'ErrorX', message: 'Something went wrong.' } })),
      'ErrorX: Something went wrong.',
    );
  });

  test('an Entra error becomes its first line, not its stack of correlation ids', () => {
    assert.equal(
      summariseError(JSON.stringify({
        error: 'invalid_client',
        error_description: 'AADSTS7000215: Invalid client secret.\r\nTrace ID: abc\r\nTimestamp: x',
      })),
      'AADSTS7000215: Invalid client secret.\r',
    );
  });

  test('a wall of HTML from a proxy is truncated rather than logged whole', () => {
    const long = 'x'.repeat(2000);
    assert.ok(summariseError(long).length < 420);
  });

  test('an empty body says so instead of being empty', () => {
    assert.equal(summariseError(''), 'no response body');
  });
});
