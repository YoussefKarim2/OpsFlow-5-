/**
 * Permission-table tests.
 *
 * The brief's rule — "there should be only three people who are allowed to
 * create/manage user accounts" — is enforced in two independent places: this
 * table, and the super-admin flag checked in the API middleware. These tests
 * cover the table half. If someone later adds a permission to ADMIN out of
 * convenience, this is what stops it going unnoticed.
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSIONS, ROLE_PERMISSIONS, ROLE_KEYS, ROLE_LABEL,
  SUPER_ADMIN_ONLY_PERMISSIONS, can, canAny, computeLockout,
  normaliseEmail, parseSuperAdminEmails,
  type Permission, type RoleKey,
} from './permissions.js';

describe('permission table', () => {
  test('every role key has permissions and a label', () => {
    for (const key of ROLE_KEYS) {
      assert.ok(ROLE_PERMISSIONS[key], `${key} has no permission list`);
      assert.ok(ROLE_LABEL[key], `${key} has no label`);
    }
  });

  test('no role grants a permission that does not exist', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const [key, perms] of Object.entries(ROLE_PERMISSIONS)) {
      for (const p of perms) {
        assert.ok(known.has(p), `${key} grants unknown permission "${p}"`);
      }
    }
  });

  test('permission strings are unique', () => {
    assert.equal(new Set(PERMISSIONS).size, PERMISSIONS.length);
  });
});

describe('account management is restricted', () => {
  test('SUPER_ADMIN holds every permission', () => {
    assert.deepEqual(
      [...ROLE_PERMISSIONS.SUPER_ADMIN].sort(),
      [...PERMISSIONS].sort(),
    );
  });

  test('ADMIN cannot create, disable, reset or re-role an account', () => {
    for (const p of SUPER_ADMIN_ONLY_PERMISSIONS) {
      assert.equal(
        can(ROLE_PERMISSIONS.ADMIN, p), false,
        `ADMIN must not hold "${p}" — account management belongs to the super administrators`,
      );
    }
  });

  test('ADMIN keeps everything else, including visibility of accounts and the audit log', () => {
    assert.ok(can(ROLE_PERMISSIONS.ADMIN, 'user:manage'));
    assert.ok(can(ROLE_PERMISSIONS.ADMIN, 'audit:read'));
    assert.ok(can(ROLE_PERMISSIONS.ADMIN, 'shipment:override'));
    assert.ok(can(ROLE_PERMISSIONS.ADMIN, 'order:delete'));

    const missing = PERMISSIONS.filter(
      (p) => !SUPER_ADMIN_ONLY_PERMISSIONS.includes(p) && !can(ROLE_PERMISSIONS.ADMIN, p),
    );
    assert.deepEqual(missing, [], 'ADMIN unexpectedly lost operational permissions');
  });

  test('no role below ADMIN can touch accounts at all', () => {
    const operational = ROLE_KEYS.filter((k) => k !== 'SUPER_ADMIN' && k !== 'ADMIN');
    const accountPermissions: Permission[] = [
      'user:manage', 'user:create', 'user:disable', 'user:reset-password',
      'role:manage', 'role:assign', 'settings:manage', 'audit:read',
    ];
    for (const key of operational) {
      assert.equal(
        canAny(ROLE_PERMISSIONS[key as RoleKey], accountPermissions), false,
        `${key} must not hold any account-management permission`,
      );
    }
  });

  test('the coordinator keeps the order-owning permissions the brief depends on', () => {
    const coordinator = ROLE_PERMISSIONS.COORDINATOR;
    for (const p of ['order:read', 'order:create', 'order:edit', 'import:run', 'task:assign'] as Permission[]) {
      assert.ok(can(coordinator, p), `COORDINATOR lost "${p}"`);
    }
    // …and still cannot promote themselves.
    assert.equal(can(coordinator, 'user:create'), false);
    assert.equal(can(coordinator, 'role:assign'), false);
  });
});

describe('sign-in lockout', () => {
  const MAX = 8;
  const BASE = 15;

  test('does not lock before the threshold', () => {
    for (let previous = 0; previous < MAX - 1; previous++) {
      const r = computeLockout(previous, MAX, BASE);
      assert.equal(r.attempts, previous + 1);
      assert.equal(r.locked, false, `locked early at attempt ${r.attempts}`);
    }
  });

  test('locks exactly on the threshold attempt', () => {
    const r = computeLockout(MAX - 1, MAX, BASE);
    assert.equal(r.attempts, MAX);
    assert.equal(r.locked, true);
    assert.equal(r.lockMinutes, BASE);
  });

  test('the counter runs across lockouts rather than resetting', () => {
    // The regression this guards: zeroing the counter at the lock hands the
    // attacker a fresh allowance every window, forever.
    assert.equal(computeLockout(MAX, MAX, BASE).attempts, MAX + 1);
    assert.equal(computeLockout(MAX, MAX, BASE).locked, false);
    assert.equal(computeLockout(2 * MAX - 1, MAX, BASE).locked, true);
  });

  test('each successive lockout is twice as long', () => {
    assert.equal(computeLockout(1 * MAX - 1, MAX, BASE).lockMinutes, 15);
    assert.equal(computeLockout(2 * MAX - 1, MAX, BASE).lockMinutes, 30);
    assert.equal(computeLockout(3 * MAX - 1, MAX, BASE).lockMinutes, 60);
    assert.equal(computeLockout(4 * MAX - 1, MAX, BASE).lockMinutes, 120);
  });

  test('lockouts stop growing at the ceiling', () => {
    const r = computeLockout(20 * MAX - 1, MAX, BASE);
    assert.equal(r.locked, true);
    assert.equal(r.lockMinutes, 24 * 60);
  });

  test('an unlocked result reports no lock duration', () => {
    const r = computeLockout(0, MAX, BASE);
    assert.deepEqual(r, { attempts: 1, locked: false, lockMinutes: 0 });
  });
});

describe('super-admin allowlist parsing', () => {
  test('normalises case and surrounding space', () => {
    assert.equal(normaliseEmail('  Ahmed@SoccerTex.biz '), 'ahmed@soccertex.biz');
  });

  test('splits on commas, semicolons and whitespace', () => {
    assert.deepEqual(
      parseSuperAdminEmails('ahmed@soccertex.biz, laila@soccertex.biz'),
      ['ahmed@soccertex.biz', 'laila@soccertex.biz'],
    );
    assert.deepEqual(
      parseSuperAdminEmails('ahmed@soccertex.biz;laila@soccertex.biz\n third@soccertex.biz'),
      ['ahmed@soccertex.biz', 'laila@soccertex.biz', 'third@soccertex.biz'],
    );
  });

  test('drops duplicates and anything that is not an address', () => {
    assert.deepEqual(
      parseSuperAdminEmails('ahmed@soccertex.biz, AHMED@soccertex.biz, , not-an-email'),
      ['ahmed@soccertex.biz'],
    );
  });

  test('an unset or empty setting yields nobody rather than everybody', () => {
    assert.deepEqual(parseSuperAdminEmails(undefined), []);
    assert.deepEqual(parseSuperAdminEmails(''), []);
    assert.deepEqual(parseSuperAdminEmails('   '), []);
  });
});
