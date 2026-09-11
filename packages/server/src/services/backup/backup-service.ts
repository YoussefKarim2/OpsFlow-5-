/**
 * Taking a copy of the database that survives losing the database.
 *
 * The premise is that a backup nobody has restored is a hope rather than a
 * backup, and that a copy kept on the same machine as the thing it protects is
 * not one at all. So this produces a single self-contained file, and
 * `restore.ts` next door reads it back — the two are written together and
 * tested against each other.
 *
 * A logical dump, table by table, rather than `pg_dump`. The deploy image is a
 * Node image with no Postgres client binaries in it, so requiring one would
 * mean a backup that works on a laptop and silently does nothing in production,
 * which is worse than having none. Reading rows through the connection already
 * open needs nothing installed.
 *
 * Tables are discovered from `information_schema` rather than listed here, so a
 * table added next year is in the backup without anyone remembering to add it.
 * `_prisma_migrations` is included deliberately: data restored without the
 * migration state gives a database that looks right and that `migrate deploy`
 * will then try to rebuild from scratch.
 */

import { gzipSync, gunzipSync } from 'node:zlib';
import { prisma } from '../../db.js';

/** What a dump file contains, once un-gzipped. */
export interface BackupPayload {
  /** Bumped only if the shape below changes incompatibly. */
  formatVersion: 1;
  takenAt: string;
  /** Row counts per table, so a restore can be checked without parsing it all. */
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
}

/**
 * Values Postgres returns that JSON cannot describe.
 *
 * Dates become ISO strings and Buffers base64. Prisma's `Decimal` becomes its
 * exact string rather than a float: a price that survives a backup as
 * 8.000000000000001 is a corrupted price, and silently so.
 */
function encode(value: unknown): unknown {
  if (value == null) return value;
  if (value instanceof Date) return { __t: 'date', v: value.toISOString() };
  if (Buffer.isBuffer(value)) return { __t: 'buf', v: value.toString('base64') };
  if (typeof value === 'bigint') return { __t: 'bigint', v: value.toString() };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === 'object' && value.constructor?.name === 'Decimal') {
    return { __t: 'decimal', v: String(value) };
  }
  return value;
}

export function decode(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value === 'object') {
    const t = (value as { __t?: string }).__t;
    const v = (value as { v?: string }).v;
    if (t === 'date') return new Date(v!);
    if (t === 'buf') return Buffer.from(v!, 'base64');
    if (t === 'bigint') return BigInt(v!);
    if (t === 'decimal') return v!;               // a string round-trips exactly
  }
  return value;
}

/** Every table in the public schema, alphabetically so two dumps are comparable. */
export async function listTables(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

/**
 * Read the whole database into one gzipped JSON document.
 *
 * Inside a single transaction, so the copy is of one moment. Without that, a
 * carton written between dumping `packing_lists` and dumping `cartons` produces
 * a backup whose own foreign keys do not resolve — a file that looks fine until
 * the day it is needed.
 */
export async function createBackup(): Promise<{
  buffer: Buffer;
  meta: Omit<BackupPayload, 'tables'>;
}> {
  const tables = await listTables();
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  await prisma.$transaction(async (tx) => {
    for (const table of tables) {
      const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "${table}"`);
      data[table] = rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, encode(v)])));
      counts[table] = rows.length;
    }
  });

  const payload: BackupPayload = {
    formatVersion: 1, takenAt: new Date().toISOString(), counts, tables: data,
  };

  return {
    buffer: gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }),
    meta: { formatVersion: 1, takenAt: payload.takenAt, counts },
  };
}

/** Un-gzip and parse a dump. Throws rather than guessing at an unknown format. */
export function readBackup(buffer: Buffer): BackupPayload {
  const parsed = JSON.parse(gunzipSync(buffer).toString('utf8')) as BackupPayload;
  if (parsed.formatVersion !== 1) {
    throw new Error(`This backup is format version ${parsed.formatVersion}; this build reads version 1.`);
  }
  return parsed;
}

/** A short human summary, for the email body and the admin screen. */
export function describeBackup(counts: Record<string, number>): string {
  const rows = Object.values(counts).reduce((a, b) => a + b, 0);
  const notable = ['orders', 'users', 'bom_items', 'production_records', 'change_events']
    .filter((t) => counts[t] != null)
    .map((t) => `${counts[t]!.toLocaleString()} ${t.replace(/_/g, ' ')}`);
  return `${rows.toLocaleString()} rows across ${Object.keys(counts).length} tables`
    + (notable.length > 0 ? ` — ${notable.join(', ')}` : '');
}
