import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signInIp } from './admin.js';

describe('sign-in addresses on the activity log', () => {
  test('a sign-in event shows the address it came from', () => {
    assert.equal(signInIp('LOGIN', { ip: '203.0.113.7' }), '203.0.113.7');
    assert.equal(signInIp('LOGIN_FAILED', { ip: '2001:db8::1' }), '2001:db8::1');
    assert.equal(signInIp('LOGIN_LOCKED', { attempts: 8, ip: '198.51.100.2' }), '198.51.100.2');
  });

  test('no other event exposes an address, even if its details carry one', () => {
    assert.equal(signInIp('PASSWORD_CHANGED', { ip: '203.0.113.7' }), null);
    assert.equal(signInIp('ORDER_UPDATED', { ip: '203.0.113.7' }), null);
  });

  test('missing or malformed details show nothing', () => {
    assert.equal(signInIp('LOGIN', null), null);
    assert.equal(signInIp('LOGIN', { ip: 42 }), null);
    assert.equal(signInIp('LOGIN', { ip: 'x'.repeat(200) }), null);
  });
});
