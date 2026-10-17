import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { tenants } from './schema';

// Synthetic demo tenants. The ids are the Keycloak organization ids fixed in
// infra/keycloak/realm-invoice.json; the alias is what the token's `organization` claim carries.
export const DEMO_TENANTS = [
  { id: '00000000-0000-4000-8000-0000000000a1', alias: 'acme', name: 'Acme SAMPLE' },
  { id: '00000000-0000-4000-8000-0000000000a2', alias: 'globex', name: 'Globex SAMPLE' },
] as const;

/** Idempotent. Runs as the owner: the app role cannot write `tenants`. */
export async function seedDemoTenants(ownerUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const db = drizzle(pool);
    for (const t of DEMO_TENANTS) {
      await db
        .insert(tenants)
        .values(t)
        .onConflictDoUpdate({ target: tenants.id, set: { alias: t.alias, name: t.name } });
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_OWNER_URL;
  if (url === undefined || url === '') {
    console.error('Missing environment variable DATABASE_OWNER_URL');
    process.exit(1);
  }
  seedDemoTenants(url).then(
    () => console.log(`seeded ${DEMO_TENANTS.length} demo tenants`),
    (err: unknown) => {
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'seed failed');
      process.exit(1);
    },
  );
}
