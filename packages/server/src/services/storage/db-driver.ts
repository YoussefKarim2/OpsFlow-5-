import crypto from 'node:crypto';
import path from 'node:path';
import { prisma } from '../../db.js';
import type { StorageDriver, PutOptions } from './index.js';
import { NotFoundError } from '../../errors.js';

/**
 * Files stored in Postgres.
 *
 * This exists because of a specific, real failure mode rather than a
 * preference. On a container with no mounted volume — which is the default on
 * most platforms, and was true of this deployment — the local driver writes to
 * a filesystem that is destroyed on the next deploy. Every purchase order and
 * artwork file anyone had uploaded disappeared, silently, with the row in the
 * database still pointing confidently at a key that no longer existed.
 *
 * The database has durable storage and is covered by the backups, so putting
 * files there fixes both halves at once: they survive a redeploy, and they are
 * inside the nightly dump rather than being the one thing it doesn't contain.
 *
 * The trade is honest: large files in Postgres make backups bigger and are not
 * what a blob store is for. For a factory's purchase orders and artwork — a few
 * megabytes each — that is a far better trade than losing them. Move to S3 by
 * setting STORAGE_DRIVER=s3 when the volume of documents justifies it.
 */
export class DbStorageDriver implements StorageDriver {
  readonly name = 'db';

  async put(data: Buffer, options: PutOptions): Promise<string> {
    const safeName = options.fileName.replace(/[^\w.\-]+/g, '_').slice(-120);
    const key = path.posix.join(options.prefix ?? 'misc', `${crypto.randomUUID()}-${safeName}`);
    await prisma.storedFile.create({
      data: {
        key,
        fileName: options.fileName.slice(-200),
        mimeType: options.mimeType,
        size: data.byteLength,
        bytes: data,
      },
    });
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const row = await prisma.storedFile.findUnique({ where: { key }, select: { bytes: true } });
    if (!row) throw new NotFoundError('File');
    return Buffer.from(row.bytes);
  }

  async delete(key: string): Promise<void> {
    await prisma.storedFile.delete({ where: { key } }).catch(() => undefined);
  }

  async exists(key: string): Promise<boolean> {
    return (await prisma.storedFile.count({ where: { key } })) > 0;
  }

  async url(key: string): Promise<string> {
    // The same path the local driver returns, streamed by the same route, so
    // switching drivers changes nothing the browser sees — and access control
    // still applies, which a public blob URL would not.
    return `/api/files/${encodeURIComponent(key)}`;
  }
}
