import 'dotenv/config';
import { z } from 'zod';
import { parseSuperAdminEmails, parseEmailList } from '@opsflow/shared';

/**
 * The two addresses the brief names. They are the *default*, not a hardcoding:
 * `SUPER_ADMIN_EMAILS` in the environment replaces this list entirely, which is
 * how the third super admin gets added later without a deploy.
 *
 * A default exists at all so that a fresh install is never left with nobody who
 * can create an account.
 */
const DEFAULT_SUPER_ADMIN_EMAILS = 'ahmed@soccertex.biz,laila@soccertex.biz,youssefk@soccertex.biz';

/**
 * A boolean from an environment variable.
 *
 * NOT `z.coerce.boolean()`, which is `Boolean(value)` — and `Boolean("false")`
 * is `true`. Every variable below that reads "false" in `.env.example` would
 * have been silently on.
 */
const envBool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  SUPER_ADMIN_EMAILS: z.string().default(DEFAULT_SUPER_ADMIN_EMAILS),
  /**
   * How many reverse proxies sit in front of the API, or "false" for none.
   *
   * This is not cosmetic. The login rate limiter keys on `req.ip`, and with no
   * trust-proxy setting `req.ip` behind nginx is the *proxy's* address — one
   * bucket shared by the whole company, so ten bad passwords from one attacker
   * would lock every employee out of sign-in for fifteen minutes. Set it to the
   * number of proxies between the client and this process.
   */
  // Railway always puts one proxy in front of the service and sets
  // RAILWAY_ENVIRONMENT_NAME, so an unset value there means one hop — the safe
  // reading. Anywhere else, unset still means none. Set explicitly to override.
  TRUST_PROXY: z.string().default(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT ? '1' : 'false'),
  /** Failed sign-ins for one account before it is temporarily locked. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).default(8),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
  /**
   * Where uploaded files go.
   *
   *   `db`    — in Postgres. Survives a redeploy on a container with no volume,
   *             and is in the nightly offsite database backup (the in-app
   *             dump leaves the file table out). The safe default.
   *   `local` — on the filesystem. Fast, and correct *only* if STORAGE_LOCAL_DIR
   *             is a mounted volume. On a plain container it silently loses
   *             every upload on the next deploy.
   *   `s3`    — an object store, for when document volume outgrows the database.
   */
  STORAGE_DRIVER: z.enum(['local', 's3', 'db']).default('db'),
  STORAGE_LOCAL_DIR: z.string().default('./.storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),

  // ── Microsoft 365 / Outlook email ───────────────────────────────────────
  //
  // All four are optional, and OpsFlow runs completely without them: changes
  // are still tracked, the timeline still fills, and in-app notifications
  // still appear. Only the emails are held in the queue until these are set,
  // at which point the backlog goes out. That is deliberate — a factory should
  // not be unable to record production because a client secret expired.
  //
  // The secret is read here and never leaves the server. It is not in any DTO,
  // any log line, or any response.
  MICROSOFT_TENANT_ID: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** The Microsoft 365 mailbox messages are sent *from*. Must exist in the tenant. */
  MICROSOFT_SENDER_EMAIL: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  /** Keep a copy in the sender's Sent Items. Useful evidence; off costs nothing. */
  MICROSOFT_SAVE_TO_SENT_ITEMS: envBool(true),

  /**
   * Where the web app is reachable, for the "Open in OpsFlow" button.
   * Unset means the emails simply omit the link rather than pointing at a
   * localhost address in somebody's inbox.
   */
  APP_BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),

  /** How often the queue retries messages that failed or were held back. */
  // Every interval has a ceiling: past Node's timer limit (about 24.8 days)
  // setInterval fires every millisecond instead, a full-book loop that takes
  // the server down.
  EMAIL_RETRY_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(86_400).default(60),

  /**
   * How often the alert sweep re-checks every open order for deadlines,
   * overdue status and material shortages (see alert-worker.ts). Hourly by
   * default — these conditions change over hours or days, not seconds, so
   * there is nothing to gain from checking more often than that.
   */
  // ── Database backups ────────────────────────────────────────────────────
  //
  // A backup nobody has restored is not a backup, so the restore path is
  // exercised by tests rather than assumed. These settings control how often
  // one is taken and where it goes.
  //
  // BACKUP_DIR is deliberately *not* under the upload directory: on a container
  // with no mounted volume both vanish on redeploy, and keeping them separate
  // makes it obvious which one needs a volume.
  BACKUP_ENABLED: envBool(true),
  BACKUP_INTERVAL_HOURS: z.coerce.number().min(0.25).max(24 * 7).default(12),
  BACKUP_DIR: z.string().default('./.backups'),
  /** How many backups to keep on disk. Oldest beyond this are deleted. */
  BACKUP_RETAIN: z.coerce.number().int().min(1).default(14),
  /** Wait this long after boot before the first backup, so startup stays quick. */
  BACKUP_STARTUP_DELAY_SECONDS: z.coerce.number().int().min(0).default(120),
  /**
   * Mail a copy of every backup out.
   *
   * Off by default, deliberately. The nightly GitHub Actions job in
   * docs/DISASTER-RECOVERY.md is the offsite mechanism: it encrypts the dump
   * before it leaves the runner and writes it to a bucket outside Railway.
   * This email leg sends the dump *unencrypted*, and a database dump contains
   * password hashes and staff personal data — so it is a reasonable fallback
   * for a deployment that has no bucket yet, and a bad habit once it does.
   * Turning it on should be a decision, not a default.
   */
  BACKUP_EMAIL_ENABLED: envBool(false),
  /** Who receives it. Empty means the super admins. */
  BACKUP_EMAIL_TO: z.string().default(''),
  /** Graph refuses inline attachments past roughly 4 MB; stay under it. */
  BACKUP_EMAIL_MAX_BYTES: z.coerce.number().int().min(1).default(3_500_000),

  ALERT_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(2_000_000).default(3600),

  /**
   * Whether the person who made a change is also emailed about it.
   *
   * Off by default. Telling somebody what they just did is the fastest way to
   * teach a factory that OpsFlow mail is noise, and the message that matters
   * then gets missed with the rest.
   */
  NOTIFY_ACTOR: envBool(false),

  /**
   * Addresses that are emailed about **every** change, whatever it is.
   *
   * The department table in `notification-routing.ts` answers "who owns this
   * kind of work", which is the right question for the factory floor and the
   * wrong one for the two or three people who need to see everything —
   * ownership, an auditor, whoever is watching a rollout. Those people are not
   * a department, and inventing one for them would distort the routing for
   * everybody else.
   *
   * An environment setting rather than a flag on `User` because the list is
   * deployment policy, not a property of a person, and because an address here
   * does **not** have to be an OpsFlow account. A shared mailbox nobody signs
   * in to is a perfectly good place to keep a copy of everything.
   *
   * Email only: an in-app notification needs a `User` row to belong to, and
   * these addresses may not have one.
   */
  ALWAYS_NOTIFY_EMAILS: z.string().default(''),

  /**
   * The addresses that actually exist, when that is not every address OpsFlow
   * knows about. Empty — the default — means no filtering at all.
   *
   * This exists because of a failure mode the queue cannot see. A message to a
   * mailbox that does not exist is accepted by Microsoft Graph, recorded here as
   * SENT with no error, and only then rejected by Exchange, which reports the
   * failure by emailing the *sender*. Nothing OpsFlow can read ever changes. So
   * "did it arrive" is not a question this application is able to answer, and
   * the only defence is to not address mail to a mailbox that isn't there.
   *
   * Names an address, not a domain: the whole problem is that thirteen accounts
   * share a domain the company does own and mailboxes it does not have.
   *
   * Filtering, never rewriting. A message whose recipients are all filtered out
   * is not sent to somebody else instead — silently redirecting mail to a person
   * it was not addressed to is worse than not sending it.
   */
  EMAIL_RECIPIENT_ALLOWLIST: z.string().default(''),

  /**
   * The one switch for all outgoing mail: change notifications, the test
   * email and the backup email. On by default, so an environment that never
   * mentions it behaves exactly as before.
   *
   * Off means a message is not created at all — not queued to go out later.
   * Holding it PENDING (which is what happens without credentials) would send
   * the whole backlog of test changes the moment mail was switched back on,
   * which is the opposite of what turning it off during testing is for.
   */
  EMAIL_SENDING_ENABLED: envBool(true),

  /**
   * Who may accept or reject a material reservation request, besides the super
   * administrators. Comma-separated addresses; adding a person needs no code
   * change and no deploy beyond setting the variable. Anyone signed in may
   * request a reservation; it holds no stock until one of these accepts it.
   */
  RESERVATION_DECIDER_EMAILS: z.string().default('mahmoud@soccertex.biz,samy@soccertex.biz,ibrahim@soccertex.biz'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail loudly at boot rather than at the first request that needs the value.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

// The example secret is long enough to pass validation, so copying .env.example
// to production would let anyone who has read the repository sign a session as
// any user. Not refused at boot — that would take a running site down on the
// next deploy — but said as loudly as the log allows, every start.
if (config.NODE_ENV === 'production' && /change-me/i.test(config.JWT_SECRET)) {
  console.error(
    'SECURITY: JWT_SECRET is the placeholder from .env.example. Anyone can forge a session. ' +
    'Set a random value (openssl rand -hex 32) in the deployment variables now; everyone will be signed out once.',
  );
}
export const isProd = config.NODE_ENV === 'production';

/**
 * Express's `trust proxy` value: `false`, `true`, a hop count, or a list of
 * trusted addresses/subnets. A bare number is passed as a number so Express
 * treats it as a hop count rather than an address.
 */
export const TRUST_PROXY: boolean | number | string =
  config.TRUST_PROXY === 'false' ? false
  : config.TRUST_PROXY === 'true' ? true
  : /^\d+$/.test(config.TRUST_PROXY) ? Number(config.TRUST_PROXY)
  : config.TRUST_PROXY;

/** Addresses permitted to hold the super-admin flag. Parsed once, at boot. */
export const SUPER_ADMIN_EMAILS: readonly string[] = parseSuperAdminEmails(config.SUPER_ADMIN_EMAILS);

if (SUPER_ADMIN_EMAILS.length === 0) {
  console.warn(
    'SUPER_ADMIN_EMAILS is empty — no account can be granted super-admin rights, ' +
    'so no user accounts can be created or managed.',
  );
}

/**
 * Addresses copied on every change email, regardless of category, priority,
 * department or anyone's notification preferences. Parsed once, at boot.
 */
export const ALWAYS_NOTIFY_EMAILS: readonly string[] = parseEmailList(config.ALWAYS_NOTIFY_EMAILS);

/**
 * Addresses mail may actually be sent to, or empty for "no restriction".
 * Parsed once, at boot. See `EMAIL_RECIPIENT_ALLOWLIST` above.
 */
/**
 * Local disk storage on a container with no mounted volume destroys every
 * upload on the next deploy, and nothing about it looks broken until someone
 * opens an order and the purchase order they attached last month is gone. Say
 * so at boot, loudly, because the alternative is finding out the slow way.
 */
if (config.NODE_ENV === 'production' && config.STORAGE_DRIVER === 'local') {
  console.warn(
    `WARNING: STORAGE_DRIVER=local in production. Uploaded files are written to `
    + `${config.STORAGE_LOCAL_DIR}, which is lost on every redeploy unless that `
    + `path is a mounted volume. Use STORAGE_DRIVER=db (stored in Postgres, `
    + `included in backups) or s3 unless you have mounted one.`,
  );
}

export const EMAIL_RECIPIENT_ALLOWLIST: readonly string[] = parseEmailList(config.EMAIL_RECIPIENT_ALLOWLIST);

/** The `RESERVATION_DECIDER_EMAILS` setting, parsed once at boot. */
export const RESERVATION_DECIDER_EMAILS: readonly string[] = parseEmailList(config.RESERVATION_DECIDER_EMAILS);

/**
 * Whether this person may accept or reject reservation requests: a super
 * administrator (the flag and the allowlist, as everywhere), or a named decider.
 */
export function canDecideReservations(
  user: { email: string; isSuperAdmin: boolean },
  deciders: readonly string[] = RESERVATION_DECIDER_EMAILS,
): boolean {
  return user.isSuperAdmin || deciders.includes(user.email.trim().toLowerCase());
}

/**
 * Whether an address is *permitted* to be a super admin. Necessary, never
 * sufficient: the flag must also be set on the user row by an existing super
 * admin. See `user-service.ts`.
 */
export function isAllowlistedSuperAdmin(email: string): boolean {
  return SUPER_ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
