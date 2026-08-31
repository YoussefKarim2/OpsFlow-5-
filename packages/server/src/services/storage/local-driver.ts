import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { StorageDriver, PutOptions } from './index.js';
import { NotFoundError } from '../../errors.js';

/** Development driver. Keys look like `orders/<id>/<uuid>-<name>.xlsx`. */
export class LocalDiskDriver implements StorageDriver {
  readonly name = 'local';

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    // Reject traversal before it becomes a path. A key is never a path from
    // the caller's point of view, so anything containing '..' is a bug or an
    // attack, and either way must not resolve outside the storage root.
    const normalised = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
    const full = path.resolve(this.root, normalised);
    if (!full.startsWith(path.resolve(this.root))) {
      throw new Error(`Refusing to access a path outside the storage root: ${key}`);
    }
    return full;
  }

  async put(data: Buffer, options: PutOptions): Promise<string> {
    const safeName = options.fileName.replace(/[^\w.\-]+/g, '_').slice(-120);
    const key = path.posix.join(options.prefix ?? 'misc', `${crypto.randomUUID()}-${safeName}`);
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      throw new NotFoundError('File');
    }
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(this.resolve(key)).catch(() => undefined);
  }

  async exists(key: string): Promise<boolean> {
    return fs.access(this.resolve(key)).then(() => true).catch(() => false);
  }

  async url(key: string): Promise<string> {
    // Served by the server itself, so access control still applies — a local
    // file must not become a public URL just because storage is on disk.
    return `/api/files/${encodeURIComponent(key)}`;
  }
}
