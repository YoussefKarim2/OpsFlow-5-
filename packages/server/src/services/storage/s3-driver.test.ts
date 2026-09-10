/**
 * The S3 driver, against a real S3 server.
 *
 * These run against MinIO rather than a mock, because the interesting failures
 * are the ones a mock agrees with you about: path-style addressing, what a HEAD
 * on a missing key actually returns, whether a presigned URL is fetchable by
 * something that holds no credentials. The deployment target is Cloudflare R2,
 * which speaks the same protocol through the same endpoint override.
 *
 * Skipped automatically when no server is running, so the suite stays green on
 * a machine without Docker. To run them:
 *
 *   docker run -d --name opsflow-minio-test -p 9021:9000 \
 *     -e MINIO_ROOT_USER=testkeyid -e MINIO_ROOT_PASSWORD=testsecretkey123 \
 *     minio/minio:latest server /data
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';

import { S3Driver } from './s3-driver.js';
import { NotFoundError } from '../../errors.js';

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9021';
const BUCKET = 'opsflow-driver-test';

const CONFIG = {
  bucket: BUCKET,
  region: 'auto',
  accessKeyId: process.env.TEST_S3_KEY ?? 'testkeyid',
  secretAccessKey: process.env.TEST_S3_SECRET ?? 'testsecretkey123',
  endpoint: ENDPOINT,
};

async function serverIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await serverIsUp();

// ── Construction: no server needed ──────────────────────────────────────────

describe('S3 driver — refuses to start half-configured', () => {
  test('a missing bucket or region is refused', () => {
    assert.throws(() => new S3Driver({ ...CONFIG, bucket: '' }), /S3_BUCKET and S3_REGION/);
    assert.throws(() => new S3Driver({ ...CONFIG, region: '' }), /S3_BUCKET and S3_REGION/);
  });

  test('missing credentials are refused at start-up, not at the first upload', () => {
    // The alternative is a service that boots green and then fails every file
    // operation, which is a worse way to find out.
    assert.throws(() => new S3Driver({ ...CONFIG, accessKeyId: '' }), /S3_ACCESS_KEY_ID/);
    assert.throws(() => new S3Driver({ ...CONFIG, secretAccessKey: '' }), /S3_SECRET_ACCESS_KEY/);
  });

  test('a full configuration constructs', () => {
    assert.equal(new S3Driver(CONFIG).name, 's3');
  });
});

describe('S3 driver — key layout matches the local driver', () => {
  const driver = new S3Driver(CONFIG);

  test('keys are prefix/uuid-name, so a migration is a file copy', () => {
    const key = driver.buildKey({ fileName: 'PO 85.xlsx', mimeType: 'application/vnd.ms-excel', prefix: 'imports' });
    assert.match(key, /^imports\/[0-9a-f-]{36}-PO_85\.xlsx$/);
  });

  test('an absent prefix falls back to misc', () => {
    assert.match(driver.buildKey({ fileName: 'a.pdf', mimeType: 'application/pdf' }), /^misc\//);
  });

  test('a filename cannot escape its prefix', () => {
    // What matters is that an uploaded name cannot introduce a path segment and
    // land somewhere it was not meant to. Separators become underscores, so the
    // key keeps exactly the prefix it was given plus one final segment. Literal
    // dots surviving inside that segment are harmless: an S3 key is a string,
    // not a path, and the local driver normalises before it ever touches disk.
    const key = driver.buildKey({ fileName: '../../etc/passwd', mimeType: 'text/plain', prefix: 'orders/1' });
    assert.match(key, /^orders\/1\//);
    const afterPrefix = key.slice('orders/1/'.length);
    assert.ok(!afterPrefix.includes('/'), `the name added a path segment: ${key}`);
    assert.equal(key.split('/').length, 3);
  });

  test('a very long name is truncated, not refused', () => {
    const key = driver.buildKey({ fileName: `${'x'.repeat(400)}.pdf`, mimeType: 'application/pdf' });
    assert.ok(key.length < 200, `key too long: ${key.length}`);
  });
});

// ── Everything below needs the server ───────────────────────────────────────

describe('S3 driver — against a real S3 server', { skip: up ? false : 'no S3 server on ' + ENDPOINT }, () => {
  const driver = new S3Driver(CONFIG);

  before(async () => {
    const admin = new S3Client({
      region: CONFIG.region,
      endpoint: ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: CONFIG.accessKeyId, secretAccessKey: CONFIG.secretAccessKey },
    });
    try {
      await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch {
      // Already there from a previous run — fine.
    }
  });

  test('a file survives a round trip byte for byte', async () => {
    const body = Buffer.from('colour,size,qty\nSKY BLUE,YS,138\n', 'utf8');
    const key = await driver.put(body, { fileName: 'cut order.csv', mimeType: 'text/csv', prefix: 'orders/abc' });
    assert.match(key, /^orders\/abc\//);
    assert.deepEqual(await driver.get(key), body);
    await driver.delete(key);
  });

  test('binary content is not corrupted', async () => {
    // A PDF header plus every byte value, because an encoding slip shows up
    // here and nowhere in a text fixture.
    const body = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
    const key = await driver.put(body, { fileName: 'artwork.pdf', mimeType: 'application/pdf', prefix: 'reference' });
    const back = await driver.get(key);
    assert.equal(back.length, body.length);
    assert.ok(back.equals(body), 'bytes changed in transit');
    await driver.delete(key);
  });

  test('a large-ish file round trips', async () => {
    const body = Buffer.alloc(3 * 1024 * 1024, 7);
    const key = await driver.put(body, { fileName: 'big.bin', mimeType: 'application/octet-stream' });
    assert.equal((await driver.get(key)).length, body.length);
    await driver.delete(key);
  });

  test('exists reports the truth on both sides', async () => {
    const key = await driver.put(Buffer.from('x'), { fileName: 'e.txt', mimeType: 'text/plain' });
    assert.equal(await driver.exists(key), true);
    await driver.delete(key);
    assert.equal(await driver.exists(key), false);
  });

  test('exists on a key that never existed is false, not an error', async () => {
    // A HEAD on a missing key answers a bare 404 with no error code, which is
    // exactly where a naive implementation throws instead of returning false.
    assert.equal(await driver.exists('misc/no-such-object-at-all'), false);
  });

  test('get on a missing key raises NotFoundError, like the local driver', async () => {
    await assert.rejects(() => driver.get('misc/definitely-not-here'), NotFoundError);
  });

  test('delete is idempotent', async () => {
    const key = await driver.put(Buffer.from('x'), { fileName: 'd.txt', mimeType: 'text/plain' });
    await driver.delete(key);
    await assert.doesNotReject(() => driver.delete(key), 'deleting twice must not fail');
    await assert.doesNotReject(() => driver.delete('misc/never-existed'));
  });

  test('two uploads of the same filename do not collide', async () => {
    const opts = { fileName: 'same.txt', mimeType: 'text/plain', prefix: 'orders/x' };
    const a = await driver.put(Buffer.from('first'), opts);
    const b = await driver.put(Buffer.from('second'), opts);
    assert.notEqual(a, b);
    assert.equal((await driver.get(a)).toString(), 'first');
    assert.equal((await driver.get(b)).toString(), 'second');
    await driver.delete(a); await driver.delete(b);
  });

  test('a presigned URL is fetchable without credentials', async () => {
    const body = Buffer.from('presigned round trip');
    const key = await driver.put(body, { fileName: 'signed.txt', mimeType: 'text/plain' });

    const url = await driver.url(key, 300);
    assert.match(url, /X-Amz-Signature=/);
    assert.match(url, /X-Amz-Expires=300/);

    // Plain fetch: no SDK, no credentials — the browser's position exactly.
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), body.toString());

    await driver.delete(key);
  });

  test('the object is not readable without the signature', async () => {
    // The bucket must stay private: this is what "Public Access: Disabled"
    // buys, and the presigned URL is the only way in.
    const key = await driver.put(Buffer.from('secret'), { fileName: 's.txt', mimeType: 'text/plain' });
    const signed = await driver.url(key, 300);
    const bare = signed.split('?')[0]!;
    const res = await fetch(bare);
    assert.notEqual(res.status, 200, 'an unsigned URL must not return the object');
    await driver.delete(key);
  });

  after(async () => {
    // Leave the bucket; the container is thrown away by the caller.
  });
});
