import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { tenants } from './schema';

// Synthetic demo tenants. The ids are the Keycloak organization ids fixed in
// infra/keycloak/realm-invoice.json; the alias is what the token's `organization` claim carries.
export const DEMO_TENANTS = [
  { id: '00000000-0000-4000-8000-0000000000a1', alias: 'acme', name: 'Acme SAMPLE' },
  { id: '00000000-0000-4000-8000-0000000000a2', alias: 'globex', name: 'Globex SAMPLE' },
] as const;

/**
 * Idempotent. Runs as the owner: the app role cannot write `tenants`. FORCE ROW LEVEL SECURITY
 * applies to the owner too, so each row is written in a transaction whose `app.tenant_id` is that
 * row's id (a superuser, like the dev database's owner, would bypass RLS and hide this; the
 * production owner is not one, T4.7).
 */
export async function seedDemoTenants(ownerUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const db = drizzle(pool);
    for (const t of DEMO_TENANTS) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
        await tx
          .insert(tenants)
          .values(t)
          .onConflictDoUpdate({ target: tenants.id, set: { alias: t.alias, name: t.name } });
      });
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
