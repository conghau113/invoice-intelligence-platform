import type { Pool } from 'pg';

/**
 * Tables in `public` where row-level security is off, not forced, or has no policy. Empty means
 * every table is isolated. Exported so a test can prove it reports a bad table (a gate that
 * cannot fail is worthless).
 */
export async function tablesWithoutRls(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity
                 AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
      ORDER BY c.relname`,
  );
  return rows.map((r) => r.relname);
}
