import 'dotenv/config';
import { z } from 'zod';
import { parseSuperAdminEmails } from '@opsflow/shared';

/**
 * The two addresses the brief names. They are the *default*, not a hardcoding:
 * `SUPER_ADMIN_EMAILS` in the environment replaces this list entirely, which is
 * how the third super admin gets added later without a deploy.
 *
 * A default exists at all so that a fresh install is never left with nobody who
 * can create an account.
 */
const DEFAULT_SUPER_ADMIN_EMAILS = 'ahmed@soccertex.biz,laila@soccertex.biz';

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
  TRUST_PROXY: z.string().default('false'),
  /** Failed sign-ins for one account before it is temporarily locked. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).default(8),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
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
  EMAIL_RETRY_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),

  /**
   * Whether the person who made a change is also emailed about it.
   *
   * Off by default. Telling somebody what they just did is the fastest way to
   * teach a factory that OpsFlow mail is noise, and the message that matters
   * then gets missed with the rest.
   */
  NOTIFY_ACTOR: envBool(false),
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
 * Whether an address is *permitted* to be a super admin. Necessary, never
 * sufficient: the flag must also be set on the user row by an existing super
 * admin. See `user-service.ts`.
 */
export function isAllowlistedSuperAdmin(email: string): boolean {
  return SUPER_ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
