/**
 * A brake on the seed script.
 *
 * `npm run db:seed` writes demo data and deletes material movements and stock.
 * That is exactly right on a laptop and a disaster against the live database,
 * and the only thing standing between the two is which `DATABASE_URL` happened
 * to be exported in the terminal. One wrong tab and the factory's real orders
 * are sitting underneath PO A302059B.
 *
 * So the seed refuses to run unless the target looks like a development
 * database. Refusing is the default; permission is explicit, spelled out, and
 * has to be typed in full.
 */

/** Hosts a development database is actually served from. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'db', 'postgres']);

/** What `ALLOW_DESTRUCTIVE_SEED` must be set to. Deliberately not "1" or "true". */
export const SEED_OVERRIDE_PHRASE = 'i-understand-this-erases-data';

export interface SeedTarget {
  nodeEnv?: string | undefined;
  databaseUrl?: string | undefined;
  override?: string | undefined;
}

export interface SeedVerdict {
  safe: boolean;
  /** Why it was refused, phrased for whoever is staring at the terminal. */
  reason?: string;
}

/** The host portion of a Postgres URL, or null if it cannot be read. */
export function databaseHost(databaseUrl: string): string | null {
  try {
    // The URL parser handles postgres:// and postgresql:// alike.
    const host = new URL(databaseUrl).hostname.toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether seeding this target is allowed.
 *
 * Pure so the decision can be tested without a database, an environment or a
 * process to kill.
 */
export function checkSeedSafety(target: SeedTarget): SeedVerdict {
  const { nodeEnv, databaseUrl, override } = target;

  if (override === SEED_OVERRIDE_PHRASE) return { safe: true };

  if (!databaseUrl) {
    return { safe: false, reason: 'DATABASE_URL is not set, so there is no way to tell what would be seeded.' };
  }

  if (nodeEnv === 'production') {
    return {
      safe: false,
      reason: 'NODE_ENV is "production". The seed writes demo data and deletes stock movements.',
    };
  }

  const host = databaseHost(databaseUrl);
  if (host === null) {
    return { safe: false, reason: `DATABASE_URL is not a URL this can read, so the target cannot be confirmed as local.` };
  }

  if (!LOCAL_HOSTS.has(host)) {
    return {
      safe: false,
      reason:
        `DATABASE_URL points at "${host}", which is not a local database. ` +
        `Seeding a remote database overwrites whatever is already there.`,
    };
  }

  return { safe: true };
}

/**
 * Throw unless it is safe to seed. Called at the top of the seed script, before
 * a single row is touched.
 */
export function assertSafeToSeed(env: NodeJS.ProcessEnv = process.env): void {
  const verdict = checkSeedSafety({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    override: env.ALLOW_DESTRUCTIVE_SEED,
  });

  if (verdict.safe) return;

  throw new Error(
    `Refusing to seed.\n\n` +
      `  ${verdict.reason}\n\n` +
      `If you are certain — and this really is a database you are willing to lose —\n` +
      `run it again with the override spelled out in full:\n\n` +
      `  ALLOW_DESTRUCTIVE_SEED=${SEED_OVERRIDE_PHRASE} npm run db:seed\n`,
  );
}
