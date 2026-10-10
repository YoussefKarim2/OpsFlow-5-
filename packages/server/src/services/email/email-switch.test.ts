import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * EMAIL_SENDING_ENABLED=false must stop mail at the door: nothing queued,
 * nothing sent later. The config is read once at start-up, so each case runs
 * in its own process with the variable set as an operator would set it. The
 * database URL points nowhere: a disabled send must return before touching it.
 */
const queue = fileURLToPath(new URL('./email-queue.ts', import.meta.url));
const run = (enabled: string | undefined): string => {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none' };
  if (enabled === undefined) delete env.EMAIL_SENDING_ENABLED; else env.EMAIL_SENDING_ENABLED = enabled;
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { enqueueEmail } = await import(${JSON.stringify(queue)});
    const { config } = await import(${JSON.stringify(fileURLToPath(new URL('../../config.ts', import.meta.url)))});
    let id = 'not-called';
    if (!config.EMAIL_SENDING_ENABLED) id = await enqueueEmail({ recipients: ['someone@example.com'], subject: 's', bodyHtml: 'h', bodyText: 't' });
    console.log(JSON.stringify({ enabled: config.EMAIL_SENDING_ENABLED, id }));
    process.exit(0);
  `], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop()!;
};

describe('the email switch', () => {
  test('on by default, so an environment that never mentions it is unchanged', () => {
    assert.deepEqual(JSON.parse(run(undefined)), { enabled: true, id: 'not-called' });
  });

  test('off: a message is not queued and the database is never touched', () => {
    assert.deepEqual(JSON.parse(run('false')), { enabled: false, id: null });
  });
});
