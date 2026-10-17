import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import { Pool } from 'pg';

export const APP_ROLE = 'invoice_app';
// dist/db or src/db -> apps/api/drizzle
const MIGRATIONS_FOLDER = join(__dirname, '..', '..', 'drizzle');

export interface MigrateOptions {
  /** Connection of the table OWNER (needs CREATE ROLE). Never the runtime app role. */
  ownerUrl: string;
  /** Password for the app role, applied after the migrations (SQL files hold no secrets). */
  appPassword: string;
}

/** Applies pending migrations, then sets the app role password. Safe to run repeatedly. */
export async function runMigrations({ ownerUrl, appPassword }: MigrateOptions): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    // ALTER ROLE cannot take bind parameters; format('%L') quotes the literal safely.
    const { rows } = await pool.query<{ stmt: string }>(
      `SELECT format('ALTER ROLE ${APP_ROLE} PASSWORD %L', $1::text) AS stmt`,
      [appPassword],
    );
    const stmt = rows[0]?.stmt;
    if (stmt === undefined) throw new Error('Could not build the ALTER ROLE statement');
    await pool.query(stmt);
  } finally {
    await pool.end();
  }
}

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Missing environment variable ${name}`);
  return value;
}

if (require.main === module) {
  runMigrations({
    ownerUrl: requireVar('DATABASE_OWNER_URL'),
    appPassword: requireVar('APP_DB_PASSWORD'),
  }).then(
    () => console.log('migrations applied'),
    (err: unknown) => {
      // Class and message only: pg errors can carry connection details.
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'migration failed');
      process.exit(1);
    },
  );
}
