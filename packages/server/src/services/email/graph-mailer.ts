/**
 * Sending real email through Microsoft 365, using the Microsoft Graph API.
 *
 * Two HTTP calls and no dependencies.
 *
 *   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   POST https://graph.microsoft.com/v1.0/users/{sender}/sendMail
 *
 * The client-credentials flow is the right one here because OpsFlow sends mail
 * as *itself*, from a mailbox the factory owns, with nobody sitting in front of
 * it. There is no user to redirect to a consent screen at two in the morning
 * when a delivery date moves. The cost of that choice is that it needs the
 * `Mail.Send` **application** permission with administrator consent, which is
 * documented in the README rather than assumed.
 *
 * `fetch` rather than `@azure/msal-node` and `@microsoft/microsoft-graph-client`
 * on purpose. Those two libraries and their transitive dependencies are a large
 * amount of supply chain to take on for one token request and one POST, and the
 * brief asks for no unnecessary dependencies. The token cache below is the only
 * thing MSAL would have given us that we actually need.
 *
 * Nothing in this file reads the database or knows what a change is. It takes a
 * message and a list of addresses and either delivers them or throws.
 */

import { config } from '../../config.js';

export class GraphNotConfiguredError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `Microsoft 365 email is not configured. Missing: ${missing.join(', ')}. ` +
      `Set them in .env — see the "Microsoft 365 email" section of the README. ` +
      `OpsFlow works fully without this; only the emails are held back.`,
    );
    this.name = 'GraphNotConfiguredError';
  }
}

export class GraphSendError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Microsoft Graph refused the message (HTTP ${status}): ${detail}`);
    this.name = 'GraphSendError';
  }
}

/** Which settings are missing, or an empty list when email can be sent. */
export function missingGraphConfig(): string[] {
  const missing: string[] = [];
  if (!config.MICROSOFT_TENANT_ID) missing.push('MICROSOFT_TENANT_ID');
  if (!config.MICROSOFT_CLIENT_ID) missing.push('MICROSOFT_CLIENT_ID');
  if (!config.MICROSOFT_CLIENT_SECRET) missing.push('MICROSOFT_CLIENT_SECRET');
  if (!config.MICROSOFT_SENDER_EMAIL) missing.push('MICROSOFT_SENDER_EMAIL');
  return missing;
}

export function isGraphConfigured(): boolean {
  return missingGraphConfig().length === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token
// ─────────────────────────────────────────────────────────────────────────────

interface CachedToken { value: string; expiresAt: number }
let cached: CachedToken | null = null;

/** Injectable for tests. Never a real network call in the test suite. */
export type Fetcher = typeof fetch;

/**
 * A bearer token for Graph, cached until shortly before it expires.
 *
 * The 60-second margin matters: a token that expires between being read and
 * being used produces a 401 that looks like a permissions problem and is not.
 */
export async function getAccessToken(fetcher: Fetcher = fetch): Promise<string> {
  const missing = missingGraphConfig();
  if (missing.length > 0) throw new GraphNotConfiguredError(missing);

  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const url = `https://login.microsoftonline.com/${encodeURIComponent(config.MICROSOFT_TENANT_ID!)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID!,
    client_secret: config.MICROSOFT_CLIENT_SECRET!,
    // `.default` asks for whatever application permissions the app registration
    // has already been granted consent for — which is how client credentials
    // works. Asking for `Mail.Send` explicitly here is a common mistake and is
    // rejected: consent is granted in Entra, not requested per call.
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    // The secret must never reach a log, and the response body from Entra does
    // not contain it — but the request body would, so nothing here echoes it.
    throw new GraphSendError(res.status, summariseError(text));
  }

  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new GraphSendError(res.status, 'no access_token in the response');

  cached = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cached.value;
}

/** Drop the cached token — used by tests and after a 401. */
export function resetTokenCache(): void {
  cached = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Send
// ─────────────────────────────────────────────────────────────────────────────

export interface OutboundMessage {
  to: readonly string[];
  subject: string;
  html: string;
  text: string;
}

/**
 * Deliver one message to many people, as one Graph call.
 *
 * Recipients go in **Bcc**, with the sender mailbox as the single To. Two
 * reasons, and the first is the important one: a change notification going to
 * the whole factory should not publish everyone's address to everyone else.
 * The second is that it is one API call rather than one per person, which
 * matters when the factory grows and a busy afternoon means a few hundred.
 */
export async function sendMail(
  message: OutboundMessage,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const missing = missingGraphConfig();
  if (missing.length > 0) throw new GraphNotConfiguredError(missing);

  const recipients = [...new Set(message.to.map((a) => a.trim().toLowerCase()))].filter(Boolean);
  if (recipients.length === 0) return;

  const token = await getAccessToken(fetcher);
  const sender = config.MICROSOFT_SENDER_EMAIL!;

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;
  const payload = {
    message: {
      subject: message.subject,
      body: { contentType: 'HTML', content: message.html },
      toRecipients: [{ emailAddress: { address: sender } }],
      bccRecipients: recipients.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: config.MICROSOFT_SAVE_TO_SENT_ITEMS,
  };

  const res = await fetcher(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  // Graph answers a successful sendMail with 202 Accepted and no body.
  if (res.status === 202 || res.status === 200) return;

  const detail = summariseError(await res.text().catch(() => ''));
  if (res.status === 401) resetTokenCache();
  throw new GraphSendError(res.status, detail);
}

/**
 * Pull the useful sentence out of a Graph or Entra error body.
 *
 * These responses are JSON with the message nested two levels down, and the raw
 * body in a log is unreadable. Truncated, because a stack of HTML from a proxy
 * in front of Graph is not worth a thousand characters of log.
 */
export function summariseError(body: string): string {
  if (!body) return 'no response body';
  try {
    const json = JSON.parse(body) as {
      error?: { message?: string; code?: string } | string;
      error_description?: string;
    };
    if (typeof json.error === 'object' && json.error?.message) {
      return json.error.code ? `${json.error.code}: ${json.error.message}` : json.error.message;
    }
    if (json.error_description) return json.error_description.split('\n')[0]!;
    if (typeof json.error === 'string') return json.error;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return body.length > 400 ? `${body.slice(0, 397)}…` : body;
}
