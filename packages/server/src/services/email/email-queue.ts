/**
 * The outbound email queue.
 *
 * A queue that is a table and a timer. The requirement is that a failed email
 * can be retried and that its failure is visible — not that the factory runs
 * Redis, and the brief is explicit about not introducing infrastructure for
 * this. `EmailDelivery` rows are the queue, so a message survives a restart,
 * and `nextAttemptAt` is the schedule.
 *
 * The one rule this file exists to enforce: **nothing here can affect the
 * change it is announcing.** By the time `enqueueEmail` is called the order is
 * saved, the audit trail is written, the change event exists and the in-app
 * notifications are in the database. Every failure path below ends in a logged
 * error and a row marked FAILED, never in a thrown exception reaching a request.
 */

import { EmailStatus } from '@opsflow/shared';
import { prisma } from '../../db.js';
import { config, EMAIL_RECIPIENT_ALLOWLIST } from '../../config.js';
import { sendMail, isGraphConfigured, missingGraphConfig, GraphNotConfiguredError } from './graph-mailer.js';
import { nextAttemptDelayMs, MAX_ATTEMPTS } from './backoff.js';

export interface EnqueueInput {
  changeEventId?: string | null;
  recipients: readonly string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
}


/**
 * Record a message and try to send it now.
 *
 * The row is written first and always. If Graph is unconfigured or unreachable
 * the row stays PENDING and the worker picks it up later, which means turning
 * the credentials on tomorrow delivers what happened today rather than losing
 * it.
 */
/**
 * Split an addressed list into what may actually be sent and what may not.
 *
 * Pure, exported and tested for the same reason `backoff.ts` is its own module:
 * the decision matters, and it should be checkable without a database standing
 * behind it.
 *
 * An empty allowlist means no restriction — every address is deliverable. That
 * is the default and it has to be, because a misread empty setting that
 * suppressed everything would silently stop all mail, which is a worse failure
 * than the bounces the setting exists to prevent.
 *
 * Applied at the queue rather than in the routing rules on purpose. Routing
 * answers "who should be told about this"; the allowlist answers "whose mailbox
 * can receive mail at all". Merging the two would let a dead address quietly
 * change who is considered responsible for an order.
 */
export function partitionByAllowlist(
  addressed: readonly string[],
  allowlist: readonly string[],
): { deliverable: string[]; suppressed: string[] } {
  if (allowlist.length === 0) return { deliverable: [...addressed], suppressed: [] };
  const allowed = new Set(allowlist.map((a) => a.trim().toLowerCase()));
  const deliverable: string[] = [];
  const suppressed: string[] = [];
  for (const address of addressed) {
    (allowed.has(address.trim().toLowerCase()) ? deliverable : suppressed).push(address);
  }
  return { deliverable, suppressed };
}

export async function enqueueEmail(input: EnqueueInput): Promise<string | null> {
  const addressed = [...new Set(input.recipients.map((r) => r.trim().toLowerCase()))].filter(Boolean);
  if (addressed.length === 0) return null;

  const { deliverable: recipients, suppressed } = partitionByAllowlist(
    addressed, EMAIL_RECIPIENT_ALLOWLIST,
  );
  if (suppressed.length > 0) {
    // Said out loud, every time. The alternative is mail that silently reaches
    // fewer people than the system believes, which is the same class of problem
    // as the bounces this setting exists to stop.
    console.warn(
      `EMAIL RECIPIENTS SUPPRESSED (not on EMAIL_RECIPIENT_ALLOWLIST) — ` +
      `"${input.subject}": ${suppressed.join(', ')}`,
    );
  }
  if (recipients.length === 0) return null;

  const row = await prisma.emailDelivery.create({
    data: {
      changeEventId: input.changeEventId ?? null,
      recipients,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText,
      status: EmailStatus.PENDING as never,
    },
    select: { id: true },
  });

  // Try immediately so a working system feels immediate, but never wait for it.
  void attemptDelivery(row.id).catch((err: unknown) => {
    console.error('EMAIL ATTEMPT FAILED (will be retried):', err);
  });

  return row.id;
}

/**
 * One delivery attempt.
 *
 * Returns whether it was sent. Never throws: the caller is always either a
 * fire-and-forget path or the worker loop, and neither has anywhere useful to
 * put an exception.
 */
export async function attemptDelivery(id: string): Promise<boolean> {
  const row = await prisma.emailDelivery.findUnique({ where: { id } });
  if (!row || row.status === EmailStatus.SENT) return false;

  if (!isGraphConfigured()) {
    // Not a failure — a message waiting for configuration. It stays PENDING
    // with its attempt count untouched, so turning the credentials on later
    // sends the backlog instead of finding it exhausted.
    return false;
  }

  try {
    await sendMail({
      to: row.recipients,
      subject: row.subject,
      html: row.bodyHtml,
      text: row.bodyText,
    });
    await prisma.emailDelivery.update({
      where: { id },
      data: { status: EmailStatus.SENT as never, sentAt: new Date(), lastError: null },
    });
    return true;
  } catch (err) {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = attempts >= MAX_ATTEMPTS;

    await prisma.emailDelivery
      .update({
        where: { id },
        data: {
          attempts,
          lastError: message.slice(0, 1000),
          status: (exhausted ? EmailStatus.FAILED : EmailStatus.PENDING) as never,
          nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(attempts)),
        },
      })
      .catch(() => undefined);

    console.error(
      `EMAIL ${exhausted ? 'FAILED PERMANENTLY' : `FAILED (attempt ${attempts}/${MAX_ATTEMPTS})`}` +
      ` — "${row.subject}": ${message}`,
    );
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The worker
// ─────────────────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Send whatever is due. Exported so a test or an admin route can force a pass. */
export async function drainQueue(limit = 20): Promise<{ attempted: number; sent: number }> {
  if (running) return { attempted: 0, sent: 0 };
  running = true;
  try {
    const due = await prisma.emailDelivery.findMany({
      where: { status: EmailStatus.PENDING as never, nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });

    let sent = 0;
    // Sequential on purpose. Graph throttles, and a hundred parallel sends is
    // the fastest way to be told so.
    for (const row of due) {
      if (await attemptDelivery(row.id)) sent += 1;
    }
    return { attempted: due.length, sent };
  } catch (err) {
    console.error('EMAIL QUEUE DRAIN FAILED:', err);
    return { attempted: 0, sent: 0 };
  } finally {
    running = false;
  }
}

/**
 * Start the retry loop.
 *
 * Called from `index.ts`, not from `app.ts`, so that creating an app for a test
 * does not start a timer. It says plainly at boot whether email is configured,
 * because "why did no email arrive" is a question best answered by the log the
 * server already printed.
 */
export function startEmailWorker(): void {
  if (timer) return;

  const missing = missingGraphConfig();
  if (missing.length > 0) {
    console.warn(
      `  email    → NOT configured (missing ${missing.join(', ')}). ` +
      `Notifications will still be created in OpsFlow; emails are queued and sent ` +
      `once the Microsoft 365 settings are present.`,
    );
  } else {
    console.log(`  email    → Microsoft Graph as ${config.MICROSOFT_SENDER_EMAIL}`);
  }

  timer = setInterval(() => {
    void drainQueue();
  }, config.EMAIL_RETRY_INTERVAL_SECONDS * 1000);
  // Never hold the process open for the sake of the retry timer.
  timer.unref();
}

export function stopEmailWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export { GraphNotConfiguredError };
export { nextAttemptDelayMs, MAX_ATTEMPTS } from './backoff.js';
