/**
 * Storage abstraction.
 *
 * The brief asks for "a proper storage abstraction so it can later connect to
 * S3". The important consequence is in the schema: `Attachment.storageKey` is a
 * driver-agnostic key, never a filesystem path. Swapping drivers is a config
 * change, not a migration.
 */

import { config } from '../../config.js';
import { LocalDiskDriver } from './local-driver.js';
import { S3Driver } from './s3-driver.js';

export interface PutOptions {
  fileName: string;
  mimeType: string;
  /** Logical folder, e.g. 'imports' | 'orders/<id>'. */
  prefix?: string;
}

export interface StorageDriver {
  readonly name: string;
  /** Store bytes and return the key to retrieve them by. */
  put(data: Buffer, options: PutOptions): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * A URL the browser can fetch. Local returns an API path the server streams;
   * S3 returns a presigned URL.
   */
  url(key: string, expiresInSeconds?: number): Promise<string>;
}

function createDriver(): StorageDriver {
  switch (config.STORAGE_DRIVER) {
    case 's3':
      return new S3Driver({
        bucket: config.S3_BUCKET ?? '',
        region: config.S3_REGION ?? '',
        accessKeyId: config.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: config.S3_SECRET_ACCESS_KEY ?? '',
        endpoint: config.S3_ENDPOINT,
      });
    case 'local':
    default:
      return new LocalDiskDriver(config.STORAGE_LOCAL_DIR);
  }
}

export const storage: StorageDriver = createDriver();
