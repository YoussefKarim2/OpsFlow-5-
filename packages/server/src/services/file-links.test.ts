import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { signFileToken, verifyFileToken, signedFileUrl } from './file-links.js';
import { verifySessionToken } from '../middleware/auth.js';

/**
 * A download link is a credential that travels in a URL — in an address bar, a
 * browser history, a server log, a pasted message. Everything here is about
 * keeping the blast radius of that to exactly one file for exactly a few
 * minutes.
 */
describe('signed download links', () => {
  const KEY = 'orders/abc/uuid-proforma.pdf';
  const USER = 'user_1';

  test('a link opens the file it was issued for', () => {
    assert.equal(verifyFileToken(signFileToken(KEY, USER), KEY), USER);
  });

  test('a link to one file is not a link to another', () => {
    // The whole scheme fails here if the key is trusted rather than compared.
    const token = signFileToken(KEY, USER);
    assert.equal(verifyFileToken(token, 'orders/xyz/someone-elses.pdf'), null);
  });

  test('a tampered link is refused', () => {
    assert.equal(verifyFileToken(`${signFileToken(KEY, USER)}x`, KEY), null);
  });

  test('a token signed with another secret is refused', () => {
    const forged = jwt.sign({ typ: 'file', key: KEY, sub: USER }, 'not-the-secret');
    assert.equal(verifyFileToken(forged, KEY), null);
  });

  test('an expired link is refused', () => {
    const stale = jwt.sign(
      { typ: 'file', key: KEY, sub: USER },
      process.env.JWT_SECRET!,
      { expiresIn: -10 },
    );
    assert.equal(verifyFileToken(stale, KEY), null);
  });

  test('a download link can never be used as a session', () => {
    // The reason `typ` exists. A URL is far more exposed than a header, and a
    // leaked link must not become a login.
    assert.equal(verifySessionToken(signFileToken(KEY, USER)), null);
  });

  test('a session token is not accepted as a download link either', () => {
    const session = jwt.sign({ sub: USER, email: 'a@b.c' }, process.env.JWT_SECRET!);
    assert.equal(verifyFileToken(session, KEY), null);
  });

  test('the url escapes the key, so slashes stay inside one path segment', () => {
    const url = signedFileUrl(KEY, USER);
    assert.ok(url.startsWith('/api/files/orders%2Fabc%2F'), url);
    assert.ok(url.includes('?t='));
  });

  test('a session token still verifies as a session', () => {
    // The guard above must not have broken ordinary sign-in.
    const session = jwt.sign({ sub: USER, email: 'a@b.c' }, process.env.JWT_SECRET!);
    assert.equal(verifySessionToken(session), USER);
  });
});
