/**
 * Putting a dump back.
 *
 * Written alongside `backup-service.ts` and exercised by the same test, because
 * the only property that matters about a backup is that it restores, and the
 * only way to know is to do it.
 *
 * Foreign keys are the whole difficulty. Restoring tables in dependency order
 * means computing that order and keeping it right forever; instead the whole
 * restore runs with `session_replication_role = replica`, which suspends
 * triggers and FK checks for this session only. Postgres's own `pg_restore`
 * does the same thing for the same reason. Constraints are enforced again the
 * moment the transaction ends, so a dump with a genuinely broken reference
 * fails at COMMIT rather than being quietly accepted.
 *
 * It is all one transaction. A restore that half-succeeds leaves a database
 * that is neither the old one nor the new one, which is worse than the failure
 * it was recovering from.
 */

import { prisma } from '../../db.js';
import { readBackup, decode } from './backup-service.js';

/**
 * Every column's declared type, keyed `table.column`, in a form that can be
 * appended to a placeholder as a cast.
 *
 * A parameterised INSERT sends values as text, and Postgres will not implicitly
 * turn text into an enum or a numeric — `column "type" is of type
 * "ApprovalType" but expression is of type text`. Casting only the types that
 * have bitten us would mean discovering the next one during an actual
 * emergency, so every column is cast to exactly what the database says it is.
 *
 * `format_type` renders the type the way a cast wants it, arrays (`text[]`) and
 * quoted enum names included, so the answer needs no interpretation here.
 */
async function columnCasts(
  tx: Pick<typeof prisma, '$queryRawUnsafe'>,
): Promise<Map<string, string>> {
  const rows = await tx.$queryRawUnsafe<Array<{
    table_name: string; column_name: string; type_name: string;
  }>>(
    `SELECT c.relname AS table_name,
            a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS type_name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND a.attnum > 0
        AND NOT a.attisdropped`,
  );

  const casts = new Map<string, string>();
  for (const r of rows) casts.set(`${r.table_name}.${r.column_name}`, r.type_name);
  return casts;
}

export interface RestoreResult {
  takenAt: string;
  tables: number;
  rows: number;
  skipped: string[];
}

/**
 * Replace the current contents with the dump's.
 *
 * Destructive by definition: restoring half of a backup on top of live data
 * gives a mixture of two states that nobody can reason about. The caller is
 * expected to have decided that already — the CLI asks, the API route is behind
 * a super-admin check and an explicit confirmation string.
 */
export async function restoreBackup(buffer: Buffer): Promise<RestoreResult> {
  const payload = readBackup(buffer);
  const skipped: string[] = [];
  let rows = 0;

  // Only tables this schema still has. A dump taken before a table was dropped
  // must restore the rest rather than failing entirely on the one that is gone.
  const present = new Set(
    (await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )).map((r) => r.table_name),
  );

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    const casts = await columnCasts(tx);

    for (const table of Object.keys(payload.tables)) {
      if (!present.has(table)) { skipped.push(table); continue; }
      await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }

    for (const [table, tableRows] of Object.entries(payload.tables)) {
      if (!present.has(table)) continue;
      for (const raw of tableRows as Array<Record<string, unknown>>) {
        const entries = Object.entries(raw);
        if (entries.length === 0) continue;
        const columns = entries.map(([k]) => `"${k}"`).join(', ');
        const params = entries
          .map(([k], i) => {
            const cast = casts.get(`${table}.${k}`);
            return cast ? `$${i + 1}::${cast}` : `$${i + 1}`;
          })
          .join(', ');
        const values = entries.map(([k, v]) => {
          const decoded = decode(v);
          // A JSON column holding an array would otherwise be bound as a real
          // Postgres array (`cannot cast type jsonb[] to jsonb`), because the
          // driver infers the parameter type from the JavaScript value. Handing
          // JSON over as text and letting the cast parse it keeps the document
          // intact, arrays and all.
          const type = casts.get(`${table}.${k}`);
          if ((type === 'jsonb' || type === 'json') && decoded !== null) {
            return JSON.stringify(decoded);
          }
          return decoded;
        });
        await tx.$executeRawUnsafe(
          `INSERT INTO "${table}" (${columns}) VALUES (${params})`,
          ...values,
        );
        rows += 1;
      }
    }
  }, {
    // A restore is long compared with a request, and the default five seconds
    // would abort one halfway through a table.
    timeout: 5 * 60_000,
    maxWait: 30_000,
  });

  return {
    takenAt: payload.takenAt,
    tables: Object.keys(payload.tables).length - skipped.length,
    rows,
    skipped,
  };
}
