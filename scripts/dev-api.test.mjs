import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DEV_DEFAULTS, devApiEnv, pnpmCommand } from './dev-api.mjs';

test('dev-api: fills in the three variables the API needs', () => {
  const env = devApiEnv({ PATH: '/bin' });
  assert.deepEqual(
    Object.keys(DEV_DEFAULTS).map((k) => env[k]),
    Object.values(DEV_DEFAULTS),
  );
  assert.equal(env.PATH, '/bin');
});

test('dev-api: values already set in the shell win', () => {
  const env = devApiEnv({ DATABASE_URL: 'postgres://other', NODE_ENV: 'development' });
  assert.equal(env.DATABASE_URL, 'postgres://other');
  assert.equal(env.OIDC_ISSUER_URL, DEV_DEFAULTS.OIDC_ISSUER_URL);
});

test('dev-api: refuses to run with a non-development NODE_ENV', () => {
  assert.throws(() => devApiEnv({ NODE_ENV: 'production' }), /local development only/);
});

test('dev-api: started outside pnpm it explains itself and exits 1', () => {
  const env = { ...process.env };
  delete env.npm_execpath;
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'dev-api.mjs')], {
    env,
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pnpm dev:api/);
});

test('dev-api: runs a JS pnpm with node and a native pnpm directly', () => {
  assert.deepEqual(pnpmCommand('/x/pnpm.cjs'), {
    command: process.execPath,
    args: ['/x/pnpm.cjs'],
  });
  assert.deepEqual(pnpmCommand('/x/pnpm.js'), { command: process.execPath, args: ['/x/pnpm.js'] });
  assert.deepEqual(pnpmCommand('/x/pnpm-native'), { command: '/x/pnpm-native', args: [] });
});
