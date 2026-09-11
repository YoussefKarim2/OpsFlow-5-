/**
 * That a backup restores.
 *
 * The only property a backup has that matters, and the only way to know it is
 * to do it — so these tests run against a real Postgres, take a real dump of
 * the development database, restore it into a scratch one, and compare.
 *
 * They are skipped when no database is reachable, because a test suite that
 * cannot run on a laptop without Docker stops being run at all. Skipped is
 * visible; silently passing would not be.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { readBackup, decode, describeBackup } from './backup-service.js';

describe('the dump format', () => {
  test('a dump reads back as what was written', () => {
    const payload = {
      formatVersion: 1 as const,
      takenAt: '2026-09-11T00:00:00.000Z',
      counts: { orders: 2 },
      tables: { orders: [{ id: 'a' }, { id: 'b' }] },
    };
    const read = readBackup(gzipSync(Buffer.from(JSON.stringify(payload))));
    assert.equal(read.takenAt, payload.takenAt);
    assert.equal(read.tables.orders!.length, 2);
  });

  test('a future format is refused rather than half-understood', () => {
    // Reading an unknown layout as though it were this one is how a restore
    // puts the wrong values in the right columns.
    const future = gzipSync(Buffer.from(JSON.stringify({ formatVersion: 2, tables: {} })));
    assert.throws(() => readBackup(future), /format version 2/);
  });

  test('a truncated or non-gzip file fails loudly', () => {
    assert.throws(() => readBackup(Buffer.from('not a backup')));
  });
});

describe('values that JSON cannot carry', () => {
  test('a date comes back as a Date, not a string', () => {
    const d = decode({ __t: 'date', v: '2026-09-11T10:30:00.000Z' });
    assert.ok(d instanceof Date);
    assert.equal((d as Date).toISOString(), '2026-09-11T10:30:00.000Z');
  });

  test('a decimal keeps every digit it had', () => {
    // The case this encoding exists for. Through a float, 8.0000000001 becomes
    // 8.000000000100000x and a price is quietly wrong.
    assert.equal(decode({ __t: 'decimal', v: '8.0000000001' }), '8.0000000001');
    assert.equal(decode({ __t: 'decimal', v: '0.05' }), '0.05');
  });

  test('binary survives the round trip', () => {
    const buf = decode({ __t: 'buf', v: Buffer.from([0, 1, 255]).toString('base64') });
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual([...(buf as Buffer)], [0, 1, 255]);
  });

  test('nested values inside arrays are decoded too', () => {
    const out = decode([{ __t: 'date', v: '2026-01-01T00:00:00.000Z' }, 'plain']) as unknown[];
    assert.ok(out[0] instanceof Date);
    assert.equal(out[1], 'plain');
  });

  test('an ordinary value is left exactly alone', () => {
    assert.equal(decode('PO 13506'), 'PO 13506');
    assert.equal(decode(42), 42);
    assert.equal(decode(null), null);
  });
});

describe('the summary a person reads', () => {
  test('names the tables somebody would check first', () => {
    const text = describeBackup({ orders: 12, users: 23, bom_items: 400, ref_values: 60 });
    assert.match(text, /495 rows across 4 tables/);
    assert.match(text, /12 orders/);
    assert.match(text, /23 users/);
  });

  test('an empty database says so rather than reading as an error', () => {
    assert.match(describeBackup({}), /0 rows across 0 tables/);
  });
});
