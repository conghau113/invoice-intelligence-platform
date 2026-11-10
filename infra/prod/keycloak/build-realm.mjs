#!/usr/bin/env node
// Builds the production realm (infra/prod/keycloak/realm-invoice.json) from the dev realm
// (infra/keycloak/realm-invoice.json), so the two cannot drift: roles, organizations, users and
// mappers come from one file, only what must differ in production is changed here (T4.7).
//
//   node infra/prod/keycloak/build-realm.mjs          write the production realm
//   node infra/prod/keycloak/build-realm.mjs --check  exit 1 if the committed file is stale
//
// `${VAR}` values are left for Keycloak, which replaces them from its environment at import
// (WEB_CLIENT_SECRET, DEMO_HOST, DEMO_USER_PASSWORD; see infra/prod/README.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEV_REALM = join(here, '..', '..', 'keycloak', 'realm-invoice.json');
export const PROD_REALM = join(here, 'realm-invoice.json');

const ORIGIN = 'https://${DEMO_HOST}';

/** Keycloak required actions that let a signed-in user change the (shared) account. */
export const ACCOUNT_CHANGING_ACTIONS = [
  ['CONFIGURE_TOTP', 'Configure OTP'],
  ['UPDATE_PASSWORD', 'Update Password'],
  ['UPDATE_PROFILE', 'Update Profile'],
  ['UPDATE_EMAIL', 'Update Email'],
  ['VERIFY_EMAIL', 'Verify Email'],
  ['VERIFY_PROFILE', 'Verify Profile'],
  ['TERMS_AND_CONDITIONS', 'Terms and Conditions'],
  ['webauthn-register', 'Webauthn Register'],
  ['webauthn-register-passwordless', 'Webauthn Register Passwordless'],
  ['CONFIGURE_RECOVERY_AUTHN_CODES', 'Recovery Authentication Codes'],
  ['delete_credential', 'Delete Credential'],
  ['delete_account', 'Delete Account'],
];

/** Pure transform: dev realm object in, production realm object out (input is not modified). */
export function buildProdRealm(dev) {
  const realm = structuredClone(dev);
  // dev-cli exists for the password grant in local scripts (Phát sinh T1.1); never in production.
  realm.clients = realm.clients.filter((c) => c.clientId !== 'dev-cli');
  const web = realm.clients.find((c) => c.clientId === 'web');
  if (web === undefined) throw new Error('dev realm has no "web" client');
  web.redirectUris = [`${ORIGIN}/api/auth/callback/keycloak`];
  web.webOrigins = [ORIGIN];
  web.attributes = { ...web.attributes, 'post.logout.redirect.uris': `${ORIGIN}/*` };
  // One public password for the demo accounts, set on the server (T4.8 publishes it).
  for (const user of realm.users) {
    user.credentials = (user.credentials ?? []).map((c) =>
      c.type === 'password' ? { ...c, value: '${DEMO_USER_PASSWORD}' } : c,
    );
  }
  // The accounts are shared by every visitor. Keycloak's implicit default role includes
  // account/manage-account, which would let any visitor change the password or profile and lock
  // the others out. Declare the default role without it (view-profile stays).
  realm.defaultRole = { name: `default-roles-${realm.realm}` };
  realm.roles = {
    ...realm.roles,
    realm: [
      ...(realm.roles?.realm ?? []).filter((r) => r.name !== realm.defaultRole.name),
      // Declaring realm roles explicitly means Keycloak no longer adds its built-in ones, and the
      // default role refers to them: define them as Keycloak itself does.
      ...['offline_access', 'uma_authorization']
        .filter((name) => !(realm.roles?.realm ?? []).some((r) => r.name === name))
        .map((name) => ({ name, description: `\${role_${name}}` })),
      {
        name: realm.defaultRole.name,
        description: '${role_default-roles}',
        composite: true,
        composites: {
          realm: ['offline_access', 'uma_authorization'],
          client: { account: ['view-profile'] },
        },
      },
    ],
  };
  // Removing manage-account is not enough: any client may ask Keycloak for an
  // application-initiated action (kc_action=UPDATE_PASSWORD in the login URL), which needs no
  // account role. Measured on the T4.7 rehearsal: password, profile and TOTP forms were offered
  // to a demo user. Turn every action that changes the account off; a disabled action cannot be
  // requested.
  realm.requiredActions = ACCOUNT_CHANGING_ACTIONS.map(([alias, name], i) => ({
    alias,
    name,
    providerId: alias,
    enabled: false,
    defaultAction: false,
    priority: (i + 1) * 10,
    config: {},
  }));
  // No lockout: the password is public anyway, and a lockout would let anyone block the demo.
  realm.bruteForceProtected = false;
  return realm;
}

export function render(realm) {
  return `${JSON.stringify(realm, null, 2)}\n`;
}

/** True when `prodText` is exactly what the dev realm `devText` builds to. */
export function isUpToDate(devText, prodText) {
  return prodText === render(buildProdRealm(JSON.parse(devText)));
}

function main() {
  const devText = readFileSync(DEV_REALM, 'utf8');
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(PROD_REALM, 'utf8');
    } catch {
      // missing counts as stale
    }
    if (!isUpToDate(devText, current)) {
      console.error(
        'infra/prod/keycloak/realm-invoice.json is stale: run node infra/prod/keycloak/build-realm.mjs',
      );
      process.exit(1);
    }
    console.log('production realm is up to date');
    return;
  }
  writeFileSync(PROD_REALM, render(buildProdRealm(JSON.parse(devText))));
  console.log('wrote infra/prod/keycloak/realm-invoice.json');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
