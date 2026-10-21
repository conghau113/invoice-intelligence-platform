import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DEV_DEFAULTS, devApiEnv, devScript, pnpmCommand } from './dev-api.mjs';

test('dev-api: fills in the variables the API needs, building the database URL from the password', () => {
  const env = devApiEnv({ PATH: '/bin', APP_DB_PASSWORD: 'p@ss/word' });
  assert.equal(env.NODE_ENV, DEV_DEFAULTS.NODE_ENV);
  assert.equal(env.OIDC_ISSUER_URL, DEV_DEFAULTS.OIDC_ISSUER_URL);
  assert.equal(env.DATABASE_URL, 'postgres://invoice_app:p%40ss%2Fword@localhost:5433/invoice');
  assert.equal(env.PATH, '/bin');
  assert.ok(path.isAbsolute(env.DATA_DIR), 'DATA_DIR must be absolute');
  assert.equal(env.REDIS_URL, 'redis://localhost:6380');
});

test('dev-api: values already set in the shell win', () => {
  const env = devApiEnv({
    DATABASE_URL: 'postgres://other',
    APP_DB_PASSWORD: 'ignored',
    OIDC_ISSUER_URL: 'http://idp/realms/x',
    NODE_ENV: 'development',
  });
  assert.equal(env.DATABASE_URL, 'postgres://other');
  assert.equal(env.OIDC_ISSUER_URL, 'http://idp/realms/x');
});

test('dev-api: without DATABASE_URL or a password it says what to set', () => {
  assert.throws(() => devApiEnv({}), /DATABASE_URL, or APP_DB_PASSWORD/);
  assert.throws(() => devApiEnv({ APP_DB_PASSWORD: '' }), /APP_DB_PASSWORD/);
});

test('dev-api: refuses to run with a non-development NODE_ENV', () => {
  assert.throws(
    () => devApiEnv({ NODE_ENV: 'production', APP_DB_PASSWORD: 'x' }),
    /local development only/,
  );
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

test('dev-api: the `worker` argument selects the worker script, anything else the API', () => {
  assert.equal(devScript('worker'), 'start:worker:dev');
  assert.equal(devScript(undefined), 'start:dev');
  assert.equal(devScript('other'), 'start:dev');
});

test('dev-api: runs a JS pnpm with node and a native pnpm directly', () => {
  assert.deepEqual(pnpmCommand('/x/pnpm.cjs'), {
    command: process.execPath,
    args: ['/x/pnpm.cjs'],
  });
  assert.deepEqual(pnpmCommand('/x/pnpm.js'), { command: process.execPath, args: ['/x/pnpm.js'] });
  assert.deepEqual(pnpmCommand('/x/pnpm-native'), { command: '/x/pnpm-native', args: [] });
});
