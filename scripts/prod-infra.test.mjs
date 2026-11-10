// Tests for the production demo tooling in infra/prod (T4.7): the realm builder and the
// pre-processed data snapshot. They run the real functions and the real CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildProdRealm,
  DEV_REALM,
  isUpToDate,
  PROD_REALM,
} from '../infra/prod/keycloak/build-realm.mjs';
import { fileFor, verifySnapshot } from '../infra/prod/scripts/demo-snapshot.mjs';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(import.meta.dirname, '__fixtures__', 'demo-snapshot');
const ACME = '00000000-0000-4000-8000-0000000000a1';
const FILE = '0f0f0f0f-0000-4000-8000-000000000001';

const devText = readFileSync(DEV_REALM, 'utf8');
const prod = buildProdRealm(JSON.parse(devText));

test('production realm: dev-only client, URLs and password are gone', () => {
  const text = JSON.stringify(prod);
  assert.deepEqual(
    prod.clients.map((c) => c.clientId),
    ['web', 'api'],
  );
  assert.equal(text.includes('localhost'), false);
  assert.equal(text.includes('demo-dev-only'), false);
  const web = prod.clients.find((c) => c.clientId === 'web');
  assert.deepEqual(web.redirectUris, ['https://${DEMO_HOST}/api/auth/callback/keycloak']);
  for (const user of prod.users) {
    assert.deepEqual(
      user.credentials.map((c) => c.value),
      ['${DEMO_USER_PASSWORD}'],
    );
  }
});

test('production realm: shared demo accounts cannot manage their own account', () => {
  const role = prod.roles.realm.find((r) => r.name === prod.defaultRole.name);
  assert.deepEqual(role.composites.client, { account: ['view-profile'] });
  assert.equal(JSON.stringify(prod).includes('manage-account'), false);
  // Application-initiated actions (kc_action=UPDATE_PASSWORD...) need no account role: every
  // action that changes the account is declared and disabled.
  for (const alias of ['UPDATE_PASSWORD', 'UPDATE_PROFILE', 'CONFIGURE_TOTP', 'delete_account']) {
    const action = prod.requiredActions.find((a) => a.alias === alias);
    assert.equal(action?.enabled, false, alias);
  }
  assert.equal(
    prod.requiredActions.some((a) => a.enabled !== false),
    false,
  );
  // Realm roles of the app are kept.
  for (const name of ['tenant_admin', 'accountant', 'viewer']) {
    assert.ok(
      prod.roles.realm.some((r) => r.name === name),
      name,
    );
  }
});

test('production realm: the dev realm object is not modified', () => {
  const dev = JSON.parse(devText);
  buildProdRealm(dev);
  assert.deepEqual(dev, JSON.parse(devText));
});

test('production realm: the committed file is up to date, and a changed one is caught', () => {
  const committed = readFileSync(PROD_REALM, 'utf8');
  assert.equal(isUpToDate(devText, committed), true);
  assert.equal(isUpToDate(devText, committed.replace('view-profile', 'manage-account')), false);
  const cli = spawnSync(
    process.execPath,
    [join(ROOT, 'infra/prod/keycloak/build-realm.mjs'), '--check'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
});

test('snapshot: storage keys outside tenant/<uuid>/<uuid> are refused', () => {
  const root = join(FIXTURES, 'ok', 'files');
  assert.equal(fileFor(root, `tenant/${ACME}/${FILE}`, ACME), join(root, 'tenant', ACME, FILE));
  for (const bad of [
    `tenant/${ACME}/../../etc/passwd`,
    `tenant/${ACME}/${FILE}/x`,
    `/tenant/${ACME}/${FILE}`,
    `tenant/${ACME}/name.pdf`,
    '',
  ]) {
    assert.throws(() => fileFor(root, bad, ACME), /unexpected storage key/, bad);
  }
  const other = '00000000-0000-4000-8000-0000000000a2';
  assert.throws(() => fileFor(root, `tenant/${ACME}/${FILE}`, other), /another tenant/);
});

test('snapshot: a valid snapshot verifies and yields its files', async () => {
  const { files } = await verifySnapshot(join(FIXTURES, 'ok'));
  assert.equal(files.length, 1);
  assert.equal(files[0].key, `tenant/${ACME}/${FILE}`);
  assert.equal(files[0].bytes.toString(), 'SAMPLE - SYNTHETIC DATA\n');
});

test('snapshot: a file changed after export is refused before anything is written', async () => {
  await assert.rejects(verifySnapshot(join(FIXTURES, 'bad-hash')), /hash mismatch/);
});

test('snapshot: rows of a tenant that is not a demo tenant are refused', async () => {
  await assert.rejects(verifySnapshot(join(FIXTURES, 'foreign-tenant')), /not a demo tenant/);
});

test('snapshot: a table the importer does not know is refused', async () => {
  await assert.rejects(verifySnapshot(join(FIXTURES, 'unknown-table')), /unknown table/);
});
