import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Synthetic accounts from infra/keycloak/realm-invoice.json (docs/setup/DEMO_ACCOUNTS.md).
// The password is read from that file, the single place it is defined, so no copy lives here.
interface RealmUser {
  username: string;
  credentials?: Array<{ value?: string }>;
}

function demoPassword(): string {
  // Playwright runs from apps/web.
  const realm = JSON.parse(
    readFileSync(
      join(process.cwd(), '..', '..', 'infra', 'keycloak', 'realm-invoice.json'),
      'utf8',
    ),
  ) as { users: RealmUser[] };
  const value = realm.users.find((u) => u.username === 'admin@acme.example')?.credentials?.[0]
    ?.value;
  if (!value) throw new Error('Demo password not found in infra/keycloak/realm-invoice.json');
  return value;
}

export const DEMO_PASSWORD = demoPassword();

export const ACME_ID = '00000000-0000-4000-8000-0000000000a1';
export const GLOBEX_ID = '00000000-0000-4000-8000-0000000000a2';

export const USERS = {
  admin: { email: 'admin@acme.example', tenant: 'acme' },
  accountant: { email: 'accountant@acme.example', tenant: 'acme' },
  viewer: { email: 'viewer@globex.example', tenant: 'globex' },
  consultant: { email: 'consultant@demo.example', tenant: 'acme' },
} as const;

export type UserKey = keyof typeof USERS;
