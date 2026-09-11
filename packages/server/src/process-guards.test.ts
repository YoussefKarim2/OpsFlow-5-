import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installProcessGuards } from './process-guards.js';

/**
 * These assert a *policy*, not plumbing: a stray rejection must not take the
 * server down, and an uncaught exception must. Getting that pair backwards is
 * the difference between an outage nobody can explain and one nobody notices.
 *
 * The handlers are invoked directly rather than by emitting the real process
 * events, because the test runner installs its own listeners for both and a
 * synthetic `uncaughtException` would fail the run it is trying to verify.
 */
describe('process guards', () => {
  const installed = <T>(event: 'unhandledRejection' | 'uncaughtException'): T =>
    process.listeners(event).at(-1) as T;

  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
  });

  test('an unhandled rejection is logged and the process keeps serving', () => {
    const logged: unknown[][] = [];
    let shutdowns = 0;
    installProcessGuards({ shutdown: () => { shutdowns += 1; }, log: (...a) => logged.push(a) });

    installed<(r: unknown) => void>('unhandledRejection')(new Error('email retry blew up'));

    assert.equal(shutdowns, 0, 'a background failure must not stop the server');
    assert.equal(logged.length, 1);
    assert.equal(logged[0]![0], '[unhandledRejection]');
  });

  test('an uncaught exception is logged and then shuts down for a clean restart', () => {
    const logged: unknown[][] = [];
    const reasons: string[] = [];
    installProcessGuards({ shutdown: (r) => reasons.push(r), log: (...a) => logged.push(a) });

    installed<(e: Error) => void>('uncaughtException')(new Error('state is now unknowable'));

    assert.deepEqual(reasons, ['uncaughtException']);
    // Logged before shutting down, so the restart is explainable afterwards.
    assert.equal(logged[0]![0], '[uncaughtException]');
  });

  test('a non-Error rejection reason still logs rather than throwing', () => {
    const logged: unknown[][] = [];
    installProcessGuards({ shutdown: () => {}, log: (...a) => logged.push(a) });

    installed<(r: unknown) => void>('unhandledRejection')('a bare string');

    assert.equal(logged[0]![1], 'a bare string');
  });
});
