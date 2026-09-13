/**
 * Short-lived, single-file download links.
 *
 * The problem this solves is small and stubborn: `<a href>` and `<img src>`
 * cannot carry an Authorization header, and the file route is authenticated.
 * Fetching the bytes in JavaScript and handing the browser a `blob:` URL works
 * in principle and fails in practice in too many ways to chase — a content
 * policy that will not render blobs, a pop-up blocker that kills a tab opened
 * across an `await`, a browser that refuses to navigate to one at all. Each is
 * fixable; the combination is not reliably fixable, and the user just sees a
 * file that will not open.
 *
 * A signed link removes the whole category. The URL is ordinary and
 * same-origin, so the browser treats it like any other document: PDFs open in
 * its own viewer, images display, everything else downloads. Nothing depends on
 * JavaScript succeeding.
 *
 * The cost is a credential in a URL, so it is made as small as one can be:
 *
 *   - it names exactly one storage key, and is rejected for any other;
 *   - it expires in minutes, not hours;
 *   - it carries `typ: 'file'`, and `authenticate` refuses any token wearing
 *     that mark — so a link that leaks into a log or a chat message cannot be
 *     turned round and used as a session.
 *
 * This is the same bargain the S3 driver already makes with presigned URLs;
 * the local and database drivers simply had no equivalent until now.
 */

import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/** Minutes a download link stays valid. Long enough to click, short enough to matter. */
const TTL_SECONDS = 15 * 60;

export interface FileTokenPayload {
  typ: 'file';
  /** The one storage key this link may fetch. */
  key: string;
  /** Who asked for it, so the access can be attributed. */
  sub: string;
}

export function signFileToken(key: string, userId: string): string {
  return jwt.sign(
    { typ: 'file', key, sub: userId } satisfies FileTokenPayload,
    config.JWT_SECRET,
    { expiresIn: TTL_SECONDS },
  );
}

/**
 * The user this token authorises for this key, or null.
 *
 * The key is compared rather than trusted: without that check a link to one
 * file would be a link to every file, which is the only way a scheme like this
 * goes badly wrong.
 */
export function verifyFileToken(token: string, key: string): string | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as Partial<FileTokenPayload>;
    if (payload.typ !== 'file') return null;
    if (payload.key !== key) return null;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** The URL the browser can open directly. */
export function signedFileUrl(key: string, userId: string): string {
  return `/api/files/${encodeURIComponent(key)}?t=${encodeURIComponent(signFileToken(key, userId))}`;
}
