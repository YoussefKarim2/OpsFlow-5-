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
  SUPER_ADMIN_ONLY_PERMISSIONS, SYSTEM_ADMIN_PERMISSIONS, can, canAny, computeLockout,
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

/**
 * Laying & marking import access, kept apart from cutting write access.
 *
 * These two permissions were briefly the same one. Gating the import on
 * `cutting:write` meant that making the button reachable for coordinators also
 * handed Finance and Packing the ability to add markers and regenerate a cut
 * order. The tests below are the record of which half each role is meant to
 * have, so the two cannot quietly collapse back together.
 *
 * Named against the people the model was written for, because "COORDINATOR has
 * import:laying" is a fact about a table and "Hassouna can file the sheet" is
 * the thing that was actually asked for.
 */
describe('laying import is separate from cutting', () => {
  const has = (role: RoleKey, p: Permission) => ROLE_PERMISSIONS[role].includes(p);

  // Who files the laying & marking sheet.
  const MAY_IMPORT: RoleKey[] = [
    'SUPER_ADMIN',       // administrators, by construction
    'ADMIN',
    'LEAD_COORDINATOR',  // Ahmed Samy Abozeid
    'COORDINATOR',       // Hassouna, Ibrahim Abozeid, Sabry, Helmy
    'FACTORY_MANAGER',   // Ahmed Aarfa, Serag Mohamed, Mahmoud Mostafa
  ];

  // Who actually cuts. Unchanged by the import work, and that is the point.
  const MAY_CUT: RoleKey[] = ['SUPER_ADMIN', 'ADMIN', 'LEAD_COORDINATOR', 'FACTORY_MANAGER'];

  for (const role of MAY_IMPORT) {
    test(`${role} can run the laying import`, () => {
      assert.ok(has(role, 'import:laying'), `${role} should hold import:laying`);
    });
  }

  for (const role of ROLE_KEYS.filter((r) => !MAY_IMPORT.includes(r))) {
    test(`${role} cannot run the laying import`, () => {
      assert.ok(!has(role, 'import:laying'), `${role} should not hold import:laying`);
    });
  }

  test('Finance gets neither half', () => {
    // Explicitly required: Finance had no reason to reach either, and only ever
    // held cutting:write because the import gate borrowed it.
    assert.ok(!has('FINANCE', 'cutting:write'));
    assert.ok(!has('FINANCE', 'import:laying'));
  });

  for (const role of ROLE_KEYS.filter((r) => !MAY_CUT.includes(r))) {
    test(`${role} cannot write cutting data`, () => {
      assert.ok(!has(role, 'cutting:write'), `${role} should not hold cutting:write`);
    });
  }

  test('the roles that cut kept the permission to cut', () => {
    // The cutters must not lose access as a side effect of narrowing the import.
    for (const role of MAY_CUT) assert.ok(has(role, 'cutting:write'), `${role} lost cutting:write`);
  });

  test('a coordinator can import without being able to cut', () => {
    // The whole purpose of splitting the permission, in one assertion.
    assert.ok(has('COORDINATOR', 'import:laying'));
    assert.ok(!has('COORDINATOR', 'cutting:write'));
  });

  test('narrowing the import did not disturb the rest of a coordinator', () => {
    for (const p of ['order:create', 'order:edit', 'material:edit', 'packing:approve',
                     'shipment:write', 'costing:write', 'import:run'] as Permission[]) {
      assert.ok(has('COORDINATOR', p), `COORDINATOR lost ${p}`);
    }
  });

  test('nor the factory manager, nor Finance', () => {
    for (const p of ['production:write', 'order:edit', 'approval:record'] as Permission[]) {
      assert.ok(has('FACTORY_MANAGER', p), `FACTORY_MANAGER lost ${p}`);
    }
    for (const p of ['costing:read', 'costing:write'] as Permission[]) {
      assert.ok(has('FINANCE', p), `FINANCE lost ${p}`);
    }
  });

  test('import:laying is a real permission, not a typo that silently never matches', () => {
    assert.ok(PERMISSIONS.includes('import:laying'));
    // The general workbook import is a different thing and still exists.
    assert.ok(PERMISSIONS.includes('import:run'));
  });
});

/**
 * The Lead Coordinator: every operational power, no administrative ones.
 *
 * The role exists because "may edit essentially everything" and "may create
 * accounts" kept being treated as the same request. They are not, and the tests
 * below are what keeps them apart — particularly the last one, which fails if
 * somebody later widens the role by reaching for ADMIN.
 */
describe('lead coordinator', () => {
  const lead = ROLE_PERMISSIONS.LEAD_COORDINATOR;

  test('can do everything a coordinator can', () => {
    for (const p of ROLE_PERMISSIONS.COORDINATOR) {
      assert.ok(lead.includes(p), `LEAD_COORDINATOR is missing the coordinator's ${p}`);
    }
  });

  test('adds the operational reach a coordinator lacks', () => {
    for (const p of ['cutting:write', 'import:laying', 'production:write',
                     'material:issue', 'quality:audit'] as Permission[]) {
      assert.ok(lead.includes(p), `LEAD_COORDINATOR should hold ${p}`);
    }
  });

  test('administers orders, not OpsFlow', () => {
    // The distinction the role was created to draw. Broad authority over the
    // factory is not a reason to hold the power to mint an account, and a role
    // that can grant itself more is bounded by nothing.
    for (const p of SYSTEM_ADMIN_PERMISSIONS) {
      assert.ok(!lead.includes(p), `LEAD_COORDINATOR must not hold ${p}`);
    }
  });

  test('holds no super-admin-only permission', () => {
    for (const p of SUPER_ADMIN_ONLY_PERMISSIONS) assert.ok(!lead.includes(p));
  });

  test('is narrower than ADMIN, which is the reason it exists', () => {
    assert.ok(lead.length < ROLE_PERMISSIONS.ADMIN.length);
    assert.ok(lead.length > ROLE_PERMISSIONS.COORDINATOR.length);
  });

  test('packing and external ops no longer borrow the laying import', () => {
    // They only ever held it to reach Sabry and Helmy, who are coordinators now.
    assert.ok(!ROLE_PERMISSIONS.PACKING.includes('import:laying'));
    assert.ok(!ROLE_PERMISSIONS.EXTERNAL_OPS.includes('import:laying'));
  });
});

/**
 * A coordinator owns the order end to end.
 *
 * The role's comment states its exclusions by name — issuing material and
 * signing off quality, which belong to the departments accountable for them.
 * Anything else an order needs, the person who owns it must be able to do, and
 * production recording had silently fallen outside that: step 13 of the flow
 * answered 403 for the role most of the factory holds.
 */
describe('what a coordinator may do', () => {
  const has = (p: Permission) => ROLE_PERMISSIONS.COORDINATOR.includes(p);

  test('can record production', () => {
    assert.ok(has('production:write'));
  });

  test('still cannot issue material or sign off quality', () => {
    // The two named exclusions. Widening the role must not quietly take them.
    assert.ok(!has('material:issue'));
    assert.ok(!has('quality:audit'));
  });

  test('still cannot write cutting data', () => {
    // Separated deliberately when the laying import was split out.
    assert.ok(!has('cutting:write'));
  });

  test('still administers nothing', () => {
    for (const p of SYSTEM_ADMIN_PERMISSIONS) {
      assert.ok(!has(p), `COORDINATOR must not hold ${p}`);
    }
  });
});


