/**
 * Serving an attached file.
 *
 * Mounted *before* the authenticated `/api` block, because this is the one
 * route the browser reaches without being able to send a header: it is opened
 * as a link or rendered as an image. It authenticates itself, two ways —
 * a normal bearer token, or the short-lived signed link in `?t=` (see
 * `file-links.ts`). Anything else is refused exactly as before.
 */

import { Router } from 'express';
import { prisma } from '../db.js';
import { storage } from '../services/storage/index.js';
import { asyncHandler } from '../util/async-handler.js';
import { GoneError, NotFoundError, UnauthorizedError } from '../errors.js';
import { verifyFileToken } from '../services/file-links.js';
import { verifySessionToken } from '../middleware/auth.js';

export const filesRouter = Router();

filesRouter.get('/:key', asyncHandler(async (req, res) => {
  const key = decodeURIComponent(req.params.key);

  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? verifySessionToken(header.slice(7)) : null;
  const signed = typeof req.query.t === 'string' ? verifyFileToken(req.query.t, key) : null;
  if (!bearer && !signed) throw new UnauthorizedError();

  // The key must belong to an attachment on an order. Without this, any
  // authenticated user could read any object in the bucket by guessing a key —
  // including the import uploads, which have no attachment row at all.
  const attachment = await prisma.attachment.findFirst({ where: { storageKey: key } });
  if (!attachment) throw new NotFoundError('File');

  let buffer: Buffer;
  try {
    buffer = await storage.get(key);
  } catch {
    // The row survived but the bytes did not — the state left behind by files
    // written to a container's own disk before storage moved into the database.
    // Said plainly, because "not found" invites a hunt for a bug that is not
    // there: the file is genuinely gone and must be attached again.
    throw new GoneError(
      `The contents of "${attachment.fileName}" are no longer stored on the server. `
      + `It was uploaded before file storage moved into the database, so the record `
      + `survived but the file did not. Please attach it again.`,
    );
  }

  res.setHeader('Content-Type', attachment.mimeType);
  // Quoting is not enough on its own — a filename containing a quote would
  // break out of the header, so the raw quotes are stripped.
  res.setHeader('Content-Disposition', `inline; filename="${attachment.fileName.replace(/["\\]/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // A signed link is already scoped and short-lived; letting a shared cache
  // keep the bytes would outlive both properties.
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.send(buffer);
}));
