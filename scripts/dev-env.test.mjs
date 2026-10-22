import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DB_COMMANDS, dbArgs } from './db-dev.mjs';
import { DEFAULT_APP_DB_PASSWORD, describeDbTarget, devDbEnv } from './dev-env.mjs';

test('dev-env: with an empty shell it builds both URLs from the compose.yaml defaults', () => {
  const env = devDbEnv({});
  assert.equal(
    env.DATABASE_OWNER_URL,
    'postgres://invoice:invoice-dev-only@localhost:5433/invoice',
  );
  assert.equal(
    env.DATABASE_URL,
    'postgres://invoice_app:invoice-app-dev-only@localhost:5433/invoice',
  );
  assert.equal(env.APP_DB_PASSWORD, DEFAULT_APP_DB_PASSWORD);
});

test('dev-env: POSTGRES_* (the names compose.yaml reads) change the owner URL and the port', () => {
  const env = devDbEnv({
    POSTGRES_USER: 'me',
    POSTGRES_PASSWORD: 'p@ss',
    POSTGRES_PORT: '5544',
    POSTGRES_DB: 'x',
  });
  assert.equal(env.DATABASE_OWNER_URL, 'postgres://me:p%40ss@localhost:5544/x');
  assert.equal(env.DATABASE_URL, 'postgres://invoice_app:invoice-app-dev-only@localhost:5544/x');
});

test('dev-env: values already set in the shell win, including an empty-string password falling back', () => {
  const env = devDbEnv({
    APP_DB_PASSWORD: 'mine/1',
    DATABASE_OWNER_URL: 'postgres://o:o@127.0.0.1:1/d',
  });
  assert.equal(env.DATABASE_OWNER_URL, 'postgres://o:o@127.0.0.1:1/d');
  assert.equal(env.DATABASE_URL, 'postgres://invoice_app:mine%2F1@localhost:5433/invoice');
  assert.equal(devDbEnv({ APP_DB_PASSWORD: '' }).APP_DB_PASSWORD, DEFAULT_APP_DB_PASSWORD);
});

test('dev-env: refuses a non-development NODE_ENV', () => {
  assert.throws(() => devDbEnv({ NODE_ENV: 'production' }), /local development only/);
  assert.throws(() => devDbEnv({ NODE_ENV: 'test' }), /local development only/);
  assert.doesNotThrow(() => devDbEnv({ NODE_ENV: 'development' }));
});

test('dev-env: never applies the default app password to a database on another machine', () => {
  assert.throws(
    () => devDbEnv({ DATABASE_OWNER_URL: 'postgres://o:o@db.example.com:5432/x' }),
    /another machine/,
  );
  assert.throws(() => devDbEnv({ DATABASE_URL: 'not a url' }), /another machine/);
  // The caller chose the password explicitly: allowed.
  assert.doesNotThrow(() =>
    devDbEnv({ DATABASE_OWNER_URL: 'postgres://o:o@db.example.com:5432/x', APP_DB_PASSWORD: 'x' }),
  );
});

test('db-dev: maps the command to the apps/api script and forwards its arguments', () => {
  assert.deepEqual(dbArgs(['migrate']), ['--filter', 'api', 'db:migrate']);
  assert.deepEqual(dbArgs(['seed:documents', 'acme', '1000']), [
    '--filter',
    'api',
    'db:seed:documents',
    'acme',
    '1000',
  ]);
  assert.deepEqual([...DB_COMMANDS].sort(), ['migrate', 'seed', 'seed:documents']);
});

test('db-dev: an unknown command is refused, and so is running it outside pnpm', () => {
  assert.throws(() => dbArgs(['drop']), /Usage/);
  const env = { ...process.env };
  delete env.npm_execpath;
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'db-dev.mjs'), 'migrate'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pnpm db:migrate/);
});

test('dev-env: names the target database and the password source, never a credential', () => {
  const before = {};
  const line = describeDbTarget(before, devDbEnv(before));
  assert.match(line, /localhost:5433\/invoice/);
  assert.match(line, /committed dev-only default/);
  assert.doesNotMatch(line, /invoice-dev-only|invoice-app-dev-only/);
  const own = { APP_DB_PASSWORD: 'mine' };
  assert.match(describeDbTarget(own, devDbEnv(own)), /from your shell/);
  assert.doesNotMatch(describeDbTarget(own, devDbEnv(own)), /mine/);
});

test('dev-env: NODE_ENV unset with a database on another machine still needs an explicit password', () => {
  assert.throws(
    () => devDbEnv({ DATABASE_URL: 'postgres://u:p@staging.example.com:5432/x' }),
    /another machine/,
  );
});
