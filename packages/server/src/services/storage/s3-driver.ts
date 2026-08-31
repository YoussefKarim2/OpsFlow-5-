import crypto from 'node:crypto';
import path from 'node:path';
import type { StorageDriver, PutOptions } from './index.js';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string | undefined;
}

/**
 * S3 driver.
 *
 * Deliberately left as a typed stub rather than pulling `@aws-sdk/client-s3`
 * into the dependency tree before it is needed. The interface is what matters:
 * the rest of the application already stores driver-agnostic keys, so switching
 * to S3 means installing the SDK, filling in these five methods, and setting
 * `STORAGE_DRIVER=s3`. No schema change, no calling-code change.
 *
 * To implement:
 *   npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner -w @opsflow/server
 */
export class S3Driver implements StorageDriver {
  readonly name = 's3';

  constructor(private readonly config: S3Config) {
    if (!config.bucket || !config.region) {
      throw new Error(
        'STORAGE_DRIVER=s3 requires S3_BUCKET and S3_REGION. Set them in .env, or use STORAGE_DRIVER=local.',
      );
    }
  }

  /** Key layout is identical to the local driver, so migration is a file copy. */
  buildKey(options: PutOptions): string {
    const safeName = options.fileName.replace(/[^\w.\-]+/g, '_').slice(-120);
    return path.posix.join(options.prefix ?? 'misc', `${crypto.randomUUID()}-${safeName}`);
  }

  async put(_data: Buffer, _options: PutOptions): Promise<string> {
    throw new Error('S3Driver.put is not implemented yet. See the notes in s3-driver.ts.');
  }

  async get(_key: string): Promise<Buffer> {
    throw new Error('S3Driver.get is not implemented yet.');
  }

  async delete(_key: string): Promise<void> {
    throw new Error('S3Driver.delete is not implemented yet.');
  }

  async exists(_key: string): Promise<boolean> {
    throw new Error('S3Driver.exists is not implemented yet.');
  }

  async url(_key: string, _expiresInSeconds = 900): Promise<string> {
    throw new Error('S3Driver.url is not implemented yet — it should return a presigned GET URL.');
  }
}
