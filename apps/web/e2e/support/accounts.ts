// Synthetic accounts from infra/keycloak/realm-invoice.json (docs/setup/DEMO_ACCOUNTS.md).
// The password is public and valid only in the local/CI Keycloak.
export const DEMO_PASSWORD = 'demo-dev-only';

export const ACME_ID = '00000000-0000-4000-8000-0000000000a1';
export const GLOBEX_ID = '00000000-0000-4000-8000-0000000000a2';

export const USERS = {
  admin: { email: 'admin@acme.example', tenant: 'acme' },
  accountant: { email: 'accountant@acme.example', tenant: 'acme' },
  viewer: { email: 'viewer@globex.example', tenant: 'globex' },
  consultant: { email: 'consultant@demo.example', tenant: 'acme' },
} as const;

export type UserKey = keyof typeof USERS;
