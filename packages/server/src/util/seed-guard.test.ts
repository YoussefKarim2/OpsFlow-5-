/**
 * The seed's brake.
 *
 * The guarantee here is narrow and worth stating plainly: running the seed
 * against anything that is not obviously a development database has to fail,
 * and it has to fail before the first write rather than halfway through.
 *
 * The override exists because a legitimate reset of a staging database should
 * still be possible — but it is a phrase, not a flag, so it cannot be reached
 * by a stray `-y` or an exported `CI=true`.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSeedSafety, assertSafeToSeed, databaseHost, SEED_OVERRIDE_PHRASE,
} from './seed-guard.js';

const LOCAL = 'postgresql://opsflow:opsflow@localhost:5433/opsflow?schema=public';
const RAILWAY = 'postgresql://postgres:hunter2@containers-us-west-42.railway.app:7891/railway';

describe('seed guard — what counts as safe', () => {
  test('a local database is allowed', () => {
    assert.equal(checkSeedSafety({ nodeEnv: 'development', databaseUrl: LOCAL }).safe, true);
  });

  test('every local spelling is recognised', () => {
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', 'db', 'postgres']) {
      const url = `postgresql://u:p@${host}:5432/opsflow`;
      assert.equal(checkSeedSafety({ nodeEnv: 'development', databaseUrl: url }).safe, true, host);
    }
  });

  test('a remote database is refused, and the message names the host', () => {
    const v = checkSeedSafety({ nodeEnv: 'development', databaseUrl: RAILWAY });
    assert.equal(v.safe, false);
    assert.match(v.reason!, /containers-us-west-42\.railway\.app/);
  });

  test('production is refused even when the host looks local', () => {
    // A production container reaching its database over localhost is exactly
    // the case where the host check alone would wave it through.
    const v = checkSeedSafety({ nodeEnv: 'production', databaseUrl: LOCAL });
    assert.equal(v.safe, false);
    assert.match(v.reason!, /production/);
  });

  test('a missing DATABASE_URL is refused rather than assumed local', () => {
    const v = checkSeedSafety({ nodeEnv: 'development', databaseUrl: undefined });
    assert.equal(v.safe, false);
  });

  test('an unparseable DATABASE_URL is refused', () => {
    const v = checkSeedSafety({ nodeEnv: 'development', databaseUrl: 'not-a-url' });
    assert.equal(v.safe, false);
  });
});

describe('seed guard — the override', () => {
  test('the exact phrase permits a remote seed', () => {
    const v = checkSeedSafety({
      nodeEnv: 'production', databaseUrl: RAILWAY, override: SEED_OVERRIDE_PHRASE,
    });
    assert.equal(v.safe, true);
  });

  test('a near-miss does not', () => {
    for (const attempt of ['1', 'true', 'yes', 'YES', 'i-understand', SEED_OVERRIDE_PHRASE.toUpperCase()]) {
      const v = checkSeedSafety({ nodeEnv: 'production', databaseUrl: RAILWAY, override: attempt });
      assert.equal(v.safe, false, `"${attempt}" must not unlock the seed`);
    }
  });
});

describe('seed guard — how it fails', () => {
  test('assertSafeToSeed throws on a remote target and says how to override', () => {
    assert.throws(
      () => assertSafeToSeed({ NODE_ENV: 'development', DATABASE_URL: RAILWAY } as NodeJS.ProcessEnv),
      (err: Error) => {
        assert.match(err.message, /Refusing to seed/);
        assert.match(err.message, new RegExp(SEED_OVERRIDE_PHRASE));
        return true;
      },
    );
  });

  test('assertSafeToSeed is silent when the target is local', () => {
    assert.doesNotThrow(() =>
      assertSafeToSeed({ NODE_ENV: 'development', DATABASE_URL: LOCAL } as NodeJS.ProcessEnv),
    );
  });

  test('databaseHost reads the host and reports failure as null', () => {
    assert.equal(databaseHost(LOCAL), 'localhost');
    assert.equal(databaseHost(RAILWAY), 'containers-us-west-42.railway.app');
    assert.equal(databaseHost('nonsense'), null);
  });
});
