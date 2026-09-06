/**
 * The queue's backoff and its central promise.
 *
 * The promise is requirement §19: an email that cannot be sent must never be
 * able to undo a change that was saved. Everything in `email-queue.ts` that
 * could throw is wrapped, and `attemptDelivery` returns a boolean rather than
 * raising — the tests for that behaviour live in `request-context.test.ts`
 * (which proves the flusher's exceptions are caught) and in the queue's own
 * structure. What is testable without a database is the retry schedule, and it
 * is worth testing because getting it wrong means either hammering Microsoft
 * or giving up on a message that would have gone through.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { nextAttemptDelayMs, MAX_ATTEMPTS } from './backoff.js';
import { partitionByAllowlist } from './email-queue.js';

describe('the retry schedule', () => {
  test('backs off geometrically rather than hammering', () => {
    const minutes = [0, 1, 2, 3, 4].map((n) => nextAttemptDelayMs(n) / 60_000);
    assert.deepEqual(minutes, [1, 5, 25, 120, 600]);
  });

  test('each wait is longer than the last', () => {
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      assert.ok(
        nextAttemptDelayMs(i) > nextAttemptDelayMs(i - 1),
        `attempt ${i} does not wait longer than attempt ${i - 1}`,
      );
    }
  });

  test('the first retry is soon, because most failures are a blip', () => {
    assert.equal(nextAttemptDelayMs(0), 60_000);
  });

  test('the last is hours, because an expired secret is not fixed by trying again', () => {
    assert.ok(nextAttemptDelayMs(MAX_ATTEMPTS - 1) >= 10 * 3600_000 / 60);
    assert.equal(nextAttemptDelayMs(MAX_ATTEMPTS - 1), 600 * 60_000);
  });

  test('an attempt count past the end does not produce NaN or Infinity', () => {
    // A row that somehow accumulated more attempts than the table has entries
    // must still get a real timestamp, not `new Date(NaN)`.
    for (const n of [MAX_ATTEMPTS, MAX_ATTEMPTS + 10, 999]) {
      const ms = nextAttemptDelayMs(n);
      assert.ok(Number.isFinite(ms) && ms > 0, `attempt ${n} gave ${ms}`);
    }
  });

  test('giving up takes long enough to survive a working day', () => {
    // Somebody has to notice and fix it. Five attempts adding to well over
    // twelve hours means an overnight outage is still delivered in the morning.
    const total = Array.from({ length: MAX_ATTEMPTS }, (_, i) => nextAttemptDelayMs(i))
      .reduce((a, b) => a + b, 0);
    assert.ok(total / 3600_000 > 12, `gives up after only ${(total / 3600_000).toFixed(1)} hours`);
  });
});

describe('the recipient allowlist', () => {
  // The twenty mailboxes that exist in the tenant. Everything else is an
  // address somebody typed into a seed file and nobody ever owned.
  const REAL = [
    'hassona@soccertex.biz', 'abdo@soccertex.biz', 'ahmed@soccertex.biz',
    'laila@soccertex.biz', 'youssefk@soccertex.biz',
  ];

  test('an empty allowlist restricts nothing', () => {
    // The default, and it must stay permissive: a setting misread as empty that
    // suppressed everything would stop all mail, which is worse than a bounce.
    const { deliverable, suppressed } = partitionByAllowlist(['anyone@example.com'], []);
    assert.deepEqual(deliverable, ['anyone@example.com']);
    assert.deepEqual(suppressed, []);
  });

  test('a mailbox that does not exist never reaches Graph', () => {
    // The exact failure that started this: Graph accepts the message, records
    // it SENT with no error, and Exchange bounces it afterwards where nothing
    // in the application can see.
    const { deliverable, suppressed } = partitionByAllowlist(
      ['abdo@soccertex.biz', 'admin@soccertex.biz'], REAL,
    );
    assert.deepEqual(deliverable, ['abdo@soccertex.biz']);
    assert.deepEqual(suppressed, ['admin@soccertex.biz']);
  });

  test('a real recipient still gets the message when a fake one shares it', () => {
    // One bad address must not cost everybody else their notification.
    const { deliverable } = partitionByAllowlist(
      ['khaled@soccertex.biz', 'hassona@soccertex.biz', 'tamer@soccertex.biz'], REAL,
    );
    assert.deepEqual(deliverable, ['hassona@soccertex.biz']);
  });

  test('case and stray whitespace do not smuggle an address past the list', () => {
    const { deliverable, suppressed } = partitionByAllowlist(
      ['  ABDO@Soccertex.BIZ  ', 'ADMIN@soccertex.biz'], REAL,
    );
    assert.equal(deliverable.length, 1);
    assert.equal(suppressed.length, 1);
  });

  test('every address suppressed leaves nothing to send', () => {
    const { deliverable, suppressed } = partitionByAllowlist(
      ['magdy@soccertex.biz', 'tamer@soccertex.biz'], REAL,
    );
    assert.deepEqual(deliverable, []);
    assert.equal(suppressed.length, 2);
  });
});
