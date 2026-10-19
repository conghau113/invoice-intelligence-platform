import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/db/migrate';
import { seedDemoTenants } from '../../src/db/seed';

const IMAGE = 'pgvector/pgvector:pg17'; // same image as compose.yaml

/**
 * Starts a throw-away Postgres, applies the real migrations and seed, and exports the two URLs the
 * tests read. A fresh database per run means the tests prove "migrations from zero give correct
 * RLS" and never touch the dev database. jest runs this in the parent process, so the variables
 * reach the test workers and teardown can reach the container through globalThis.
 */
export default async function setup(): Promise<void> {
  const container = await new PostgreSqlContainer(IMAGE)
    .withUsername('invoice')
    .withDatabase('invoice')
    .start();
  (globalThis as { __pgContainer?: StartedPostgreSqlContainer }).__pgContainer = container;

  const ownerUrl = container.getConnectionUri();
  // Random per run, never stored: the role password is only valid inside this container.
  const appPassword = randomBytes(18).toString('hex');
  await runMigrations({ ownerUrl, appPassword });
  await seedDemoTenants(ownerUrl);

  const app = new URL(ownerUrl);
  app.username = 'invoice_app';
  app.password = appPassword;
  process.env.DATABASE_OWNER_URL = ownerUrl;
  process.env.DATABASE_URL = app.toString();
}
