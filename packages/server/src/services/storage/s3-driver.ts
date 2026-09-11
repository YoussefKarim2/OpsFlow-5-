import crypto from 'node:crypto';
import path from 'node:path';
import {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageDriver, PutOptions } from './index.js';
import { NotFoundError } from '../../errors.js';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string | undefined;
}

/**
 * S3 driver, written against the S3 API rather than against AWS.
 *
 * The deployment target is Cloudflare R2, which speaks S3 — so this is
 * configuration, not a second implementation. R2 wants `region: 'auto'`, an
 * account-specific endpoint, and path-style addressing; AWS proper wants a real
 * region and is happy either way. Setting `forcePathStyle` whenever an endpoint
 * is supplied covers R2, MinIO and every other S3-compatible server without
 * naming any of them.
 *
 * Behaviour matches LocalDiskDriver exactly, because the routes above cannot
 * tell the two apart:
 *
 *   - `buildKey` produces the same `prefix/uuid-name` layout, so moving between
 *     drivers is a file copy rather than a migration.
 *   - `get` on a missing key raises NotFoundError, not a vendor error.
 *   - `delete` is idempotent — deleting what is not there is not a failure.
 *   - `url` returns something the browser can fetch. Local returns an API path
 *     the server streams and access-controls; here it is a presigned URL that
 *     expires, which is why the bucket must stay private.
 */
export class S3Driver implements StorageDriver {
  readonly name = 's3';
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    if (!config.bucket || !config.region) {
      throw new Error(
        'STORAGE_DRIVER=s3 requires S3_BUCKET and S3_REGION. Set them in .env, or use STORAGE_DRIVER=local.',
      );
    }
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error(
        'STORAGE_DRIVER=s3 requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY. ' +
          'Without them every upload and download fails at the first request rather than at start-up.',
      );
    }

    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint
        ? { endpoint: config.endpoint, forcePathStyle: true }
        : {}),
    });
  }

  /** Key layout is identical to the local driver, so migration is a file copy. */
  buildKey(options: PutOptions): string {
    const safeName = options.fileName.replace(/[^\w.\-]+/g, '_').slice(-120);
    return path.posix.join(options.prefix ?? 'misc', `${crypto.randomUUID()}-${safeName}`);
  }

  async put(data: Buffer, options: PutOptions): Promise<string> {
    const key = this.buildKey(options);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: data,
        ContentType: options.mimeType,
        // Kept so a browser handed a presigned URL saves the file under the
        // name somebody uploaded, rather than under a UUID.
        ContentDisposition: `inline; filename="${options.fileName.replace(/"/g, '')}"`,
      }),
    );
    return key;
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!res.Body) throw new NotFoundError('File');
      // transformToByteArray is the SDK's own way of draining the stream and is
      // the same on Node and in a worker runtime.
      const bytes = await res.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      if (isMissing(err)) throw new NotFoundError('File');
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 reports deleting a missing key as success; other implementations are
    // less generous. Either way the caller asked for it to be gone.
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async url(key: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}

/**
 * "The object is not there", across the several ways S3 implementations say it.
 *
 * A GET on a missing key answers NoSuchKey; a HEAD answers a bare 404 with no
 * error code at all, because HEAD has no body to put one in. Matching only on
 * the code would make `exists` throw where it should return false.
 */
function isMissing(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.$metadata?.httpStatusCode === 404
  );
}
