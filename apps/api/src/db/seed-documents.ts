import { Pool } from 'pg';
import { DEMO_TENANTS } from './seed';

/** Uploader of every seeded row: a made-up id, not a real user. */
const SEED_UPLOADER = '00000000-0000-4000-8000-00000000f0ff';

/**
 * Inserts `count` synthetic documents for one tenant, spread over the last `count` minutes with
 * every status and type. Dev and test data only: the rows point at no stored file, and the hashes
 * come from the word SAMPLE. Runs as the owner, so it sets `app.tenant_id` itself (FORCE RLS
 * applies to the owner too). The `initial_state` policy lets a row be born only as `uploaded`,
 * so the status is set by an UPDATE afterwards, like the real state machine would. `prefix` keeps
 * two seeds for the same tenant from colliding on the unique content hash.
 */
export async function seedDocuments(
  pool: Pool,
  tenantId: string,
  count: number,
  prefix = 'seed',
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      `INSERT INTO documents (tenant_id, source_type, storage_key, content_hash, uploaded_by, created_at)
       SELECT $1::uuid,
              (ARRAY['xml','pdf','image'])[1 + i % 3],
              'tenant/' || $1 || '/sample-' || $2 || '-' || i,
              encode(sha256(convert_to('SAMPLE-' || $2 || '-' || i, 'UTF8')), 'hex'),
              $4::uuid,
              now() - (i * interval '1 minute') - (i * interval '37 microseconds')
         FROM generate_series(1, $3::int) AS i`,
      [tenantId, prefix, count, SEED_UPLOADER],
    );
    await client.query(
      `UPDATE documents
          SET status = (ARRAY['uploaded','queued','processing','needs_review','approved','rejected','failed'])
                       [1 + abs(hashtext(content_hash)) % 7]
        WHERE tenant_id = $1 AND uploaded_by = $2 AND storage_key LIKE '%/sample-' || $3 || '-%'`,
      [tenantId, SEED_UPLOADER, prefix],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_OWNER_URL;
  const alias = process.argv[2] ?? 'acme';
  const count = Number(process.argv[3] ?? 1000);
  const tenant = DEMO_TENANTS.find((t) => t.alias === alias);
  // Sample rows belong in a development database: refuse anything that is not this machine.
  const host = (() => {
    try {
      return new URL(url ?? '').hostname;
    } catch {
      return '';
    }
  })();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    console.error('db:seed:documents only runs against a database on localhost');
    process.exit(1);
  }
  if (
    url === undefined ||
    url === '' ||
    tenant === undefined ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 100_000
  ) {
    console.error('Usage: DATABASE_OWNER_URL=... db:seed:documents [acme|globex] [count]');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  seedDocuments(pool, tenant.id, count, `cli-${Date.now()}`)
    .then(() => console.log(`seeded ${count} sample documents for ${alias}`))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'seed failed');
      process.exitCode = 1;
    })
    .finally(() => void pool.end());
}
