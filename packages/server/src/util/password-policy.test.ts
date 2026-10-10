import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isExposedPassword, EXPOSED_PASSWORD_SHA256, EXPOSED_PASSWORD_MESSAGE, newPasswordRule } from './password-policy.js';
import { passwordSchema } from '../routes/auth.js';

/**
 * A published password is refused when someone chooses a new one. The tests
 * use a stand-in value rather than the real published one, so this file does
 * not republish it either.
 */
const STAND_IN = 'a-published-password-123';
const list = [createHash('sha256').update(STAND_IN).digest('hex')];

describe('published passwords', () => {
  test('the exact value is refused', () => {
    assert.equal(isExposedPassword(STAND_IN, list), true);
  });

  test('changing the case or adding spaces does not get round it', () => {
    assert.equal(isExposedPassword('  A-Published-PASSWORD-123 ', list), true);
  });

  test('any other password is accepted', () => {
    assert.equal(isExposedPassword('a-published-password-124', list), false);
    assert.equal(isExposedPassword('correct horse battery staple', list), false);
  });

  test('the real list holds fingerprints, not passwords', () => {
    assert.ok(EXPOSED_PASSWORD_SHA256.length >= 1);
    for (const h of EXPOSED_PASSWORD_SHA256) assert.match(h, /^[0-9a-f]{64}$/);
  });
});

describe('the rule for choosing a password', () => {
  const rule = newPasswordRule(list);

  test('refuses a published password and says why', () => {
    const r = rule.safeParse(STAND_IN);
    assert.equal(r.success, false);
    assert.equal(r.success ? null : r.error.issues[0]?.message, EXPOSED_PASSWORD_MESSAGE);
  });

  test('accepts an ordinary long password and still requires ten characters', () => {
    assert.equal(rule.safeParse('correct horse battery staple').success, true);
    assert.equal(rule.safeParse('short').success, false);
  });

  test('the change-password form uses it', () => {
    assert.equal(passwordSchema.safeParse({ currentPassword: 'x', newPassword: 'correct horse battery staple' }).success, true);
    assert.equal(passwordSchema.safeParse({ currentPassword: 'x', newPassword: 'short' }).success, false);
  });
});
