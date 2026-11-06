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

/**
 * Views in `public` that could get around RLS: without `security_invoker` a view reads with its
 * owner's rights, and a grant to PUBLIC reaches roles nobody meant to include. Empty means fine.
 */
export async function unsafeViews(pool: Pick<Pool, 'query'>): Promise<string[]> {
  const { rows } = await pool.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
        AND (c.relkind = 'm'
             OR NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)
             OR EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0))
      ORDER BY c.relname`,
  );
  return rows.map((r) => r.relname);
}

/**
 * Columns of `table` that `view` does not have. Postgres expands `SELECT *` once, when the view is
 * created, so a column added later is silently missing until the view is created again.
 */
export async function columnsMissingFromView(
  pool: Pick<Pool, 'query'>,
  view: string,
  table: string,
): Promise<string[]> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
     EXCEPT
     SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $2
     ORDER BY column_name`,
    [table, view],
  );
  return rows.map((r) => r.column_name);
}
