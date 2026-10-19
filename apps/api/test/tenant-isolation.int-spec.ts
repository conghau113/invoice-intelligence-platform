/**
 * Row-Level Security against a REAL Postgres, connecting as the real app role.
 * The database is started by support/postgres.global-setup.ts (Testcontainers, real migrations
 * and seed). Missing configuration FAILS the run on purpose; a skipped isolation test would look
 * green. Fixtures are inserted by the owner with fixed ids and removed again afterwards.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../src/db/tenant-db.service';
import * as schema from '../src/db/schema';
import { tablesWithoutRls } from './support/rls';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const ACME_USER = '00000000-0000-4000-8000-00000000f001';
const GLOBEX_USER = '00000000-0000-4000-8000-00000000f002';
const NEW_USER = '00000000-0000-4000-8000-00000000f003';

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set: run "pnpm --filter api test:int" (jest.int.config.js starts the database)`,
    );
  }
  return value;
}

describe('tenant isolation in Postgres (RLS)', () => {
  let owner: Pool;
  let app: Pool;

  /** Runs fn in a transaction with app.tenant_id set, exactly like TenantDbService does. */
  async function asTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async function cleanFixtures(): Promise<void> {
    const users = [ACME_USER, GLOBEX_USER, NEW_USER];
    await owner.query('DELETE FROM audit_logs WHERE action LIKE $1', ['int-test.%']);
    await owner.query('DELETE FROM memberships WHERE user_id = ANY($1)', [users]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 1 });
    // max 1 on purpose: every query reuses the same connection, like a busy pool would.
    app = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 1 });

    const { rows } = await owner.query('SELECT count(*)::int AS n FROM tenants');
    if (rows[0].n < 2) throw new Error('Run db:seed first: the demo tenants are missing');

    await cleanFixtures();
    await owner.query(
      `INSERT INTO users (id, email) VALUES ($1, 'a@example.test'), ($2, 'g@example.test')`,
      [ACME_USER, GLOBEX_USER],
    );
    await owner.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'accountant'), ($3, $4, 'viewer')`,
      [ACME, ACME_USER, GLOBEX, GLOBEX_USER],
    );
    await owner.query(
      `INSERT INTO audit_logs (tenant_id, action) VALUES ($1, 'int-test.acme'), ($2, 'int-test.globex')`,
      [ACME, GLOBEX],
    );
  });

  afterAll(async () => {
    await cleanFixtures();
    await Promise.all([owner.end(), app.end()]);
  });

  describe('the application role', () => {
    it('is not a superuser, does not bypass RLS and owns no table', async () => {
      const { rows } = await app.query(
        `SELECT current_user AS who, r.rolsuper, r.rolbypassrls,
                (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owned
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(rows[0]).toEqual({
        who: 'invoice_app',
        rolsuper: false,
        rolbypassrls: false,
        owned: 0,
      });
    });

    it('cannot change the schema', async () => {
      await expect(app.query('CREATE TABLE sneaky (id int)')).rejects.toThrow(/permission denied/);
      await expect(app.query('ALTER TABLE tenants DISABLE ROW LEVEL SECURITY')).rejects.toThrow(
        /must be owner/,
      );
    });
  });

  describe('the RLS gate itself', () => {
    it('every table in public has RLS enabled, forced and at least one policy', async () => {
      expect(await tablesWithoutRls(owner)).toEqual([]); // names every offending table
    });

    it('reports a table that has none (negative control, rolled back)', async () => {
      // One connection (max 1), so the uncommitted tables are visible to the helper's query.
      const single = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 1 });
      try {
        await single.query('BEGIN');
        await single.query('CREATE TABLE forgotten_table (id int)');
        await single.query('CREATE TABLE half_done (id int)');
        await single.query('ALTER TABLE half_done ENABLE ROW LEVEL SECURITY');
        expect(await tablesWithoutRls(single)).toEqual(['forgotten_table', 'half_done']);
      } finally {
        await single.query('ROLLBACK');
        await single.end();
      }
    });
  });

  describe('without app.tenant_id: zero rows, never an error', () => {
    it.each(['tenants', 'memberships', 'audit_logs', 'users'])('%s', async (table) => {
      const { rows } = await app.query(`SELECT * FROM ${table}`);
      expect(rows).toEqual([]);
    });

    it('also on a reused connection after a transaction that set a tenant', async () => {
      await asTenant(ACME, async (c) => {
        expect((await c.query('SELECT id FROM tenants')).rows).toHaveLength(1);
      });
      // Same single pooled connection; the setting now reads '' (not NULL) outside the tx.
      const { rows } = await app.query('SELECT * FROM tenants');
      expect(rows).toEqual([]);
      expect(
        (await app.query("SELECT current_setting('app.tenant_id', true) AS v")).rows[0].v,
      ).toBe('');
    });
  });

  describe('with app.tenant_id set', () => {
    it('sees only its own rows, even when the query asks for another tenant explicitly', async () => {
      await asTenant(ACME, async (c) => {
        expect((await c.query('SELECT id FROM tenants')).rows).toEqual([{ id: ACME }]);
        const own = await c.query(`SELECT action FROM audit_logs WHERE action LIKE 'int-test.%'`);
        expect(own.rows).toEqual([{ action: 'int-test.acme' }]);
        const other = await c.query('SELECT * FROM audit_logs WHERE tenant_id = $1', [GLOBEX]);
        expect(other.rows).toEqual([]);
        const m = await c.query('SELECT user_id FROM memberships WHERE user_id = ANY($1)', [
          [ACME_USER, GLOBEX_USER],
        ]);
        expect(m.rows).toEqual([{ user_id: ACME_USER }]);
      });
    });

    it('SELECT * with no WHERE returns only the own rows, for each tenant', async () => {
      for (const [tenant, expected] of [
        [ACME, 'int-test.acme'],
        [GLOBEX, 'int-test.globex'],
      ] as const) {
        await asTenant(tenant, async (c) => {
          const { rows } = await c.query(
            `SELECT action FROM audit_logs WHERE action LIKE 'int-test.%'`,
          );
          expect(rows).toEqual([{ action: expected }]);
          const all = await c.query('SELECT DISTINCT tenant_id FROM audit_logs');
          expect(all.rows).toEqual([{ tenant_id: tenant }]);
        });
      }
      // The owner proves both tenants' rows exist, so the filtering above is RLS and not emptiness.
      const { rows } = await owner.query(
        `SELECT count(DISTINCT tenant_id)::int AS n FROM audit_logs WHERE action LIKE 'int-test.%'`,
      );
      expect(rows[0].n).toBe(2);
    });

    it('cannot write rows for another tenant (WITH CHECK)', async () => {
      await expect(
        asTenant(ACME, (c) =>
          c.query(`INSERT INTO audit_logs (tenant_id, action) VALUES ($1, 'int-test.x')`, [GLOBEX]),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asTenant(ACME, (c) =>
          c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')`, [
            GLOBEX,
            ACME_USER,
          ]),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('cannot update or delete another tenant rows (they are invisible)', async () => {
      const upd = await asTenant(ACME, (c) =>
        c.query(`UPDATE memberships SET role = 'tenant_admin' WHERE tenant_id = $1`, [GLOBEX]),
      );
      expect(upd.rowCount).toBe(0);
      const del = await asTenant(ACME, (c) =>
        c.query('DELETE FROM memberships WHERE tenant_id = $1', [GLOBEX]),
      );
      expect(del.rowCount).toBe(0);
      const { rows } = await owner.query('SELECT role FROM memberships WHERE user_id = $1', [
        GLOBEX_USER,
      ]);
      expect(rows).toEqual([{ role: 'viewer' }]);
    });

    it('users: only members of the current tenant are visible', async () => {
      await asTenant(ACME, async (c) => {
        const { rows } = await c.query('SELECT id FROM users WHERE id = ANY($1)', [
          [ACME_USER, GLOBEX_USER],
        ]);
        expect(rows).toEqual([{ id: ACME_USER }]);
      });
    });

    it('users: a first login can insert the user, then the membership', async () => {
      await asTenant(ACME, async (c) => {
        await c.query(`INSERT INTO users (id) VALUES ($1)`, [NEW_USER]);
        await c.query(
          `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')`,
          [ACME, NEW_USER],
        );
        expect((await c.query('SELECT id FROM users WHERE id = $1', [NEW_USER])).rows).toHaveLength(
          1,
        );
      });
    });
  });

  describe('audit_logs is append-only', () => {
    it('allows INSERT for the own tenant but not UPDATE or DELETE', async () => {
      await asTenant(ACME, (c) =>
        c.query(`INSERT INTO audit_logs (tenant_id, action) VALUES ($1, 'int-test.append')`, [
          ACME,
        ]),
      );
      await expect(
        asTenant(ACME, (c) => c.query(`UPDATE audit_logs SET action = 'tampered'`)),
      ).rejects.toThrow(/permission denied/);
      await expect(asTenant(ACME, (c) => c.query('DELETE FROM audit_logs'))).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('app_resolve_tenant (alias lookup before any tenant is known)', () => {
    it('maps an alias to its id without any tenant set', async () => {
      const { rows } = await app.query("SELECT app_resolve_tenant('acme') AS id");
      expect(rows[0].id).toBe(ACME);
    });

    it('returns NULL for an unknown alias, including injection-shaped input', async () => {
      for (const alias of ['initech', "' OR '1'='1", '%', '']) {
        const { rows } = await app.query('SELECT app_resolve_tenant($1) AS id', [alias]);
        expect(rows[0].id).toBeNull();
      }
    });

    it('does not open the table itself, and leaves nothing set behind in the transaction', async () => {
      expect((await app.query('SELECT * FROM tenants')).rows).toEqual([]);
      const c = await app.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT app_resolve_tenant('acme')");
        expect((await c.query('SELECT * FROM tenants')).rows).toEqual([]);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('works when the table owner is a normal role (FORCE RLS binds owners too)', async () => {
      // Production owners are not superusers. Everything is rolled back, DDL included.
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query('CREATE ROLE tmp_owner_test NOSUPERUSER NOBYPASSRLS');
        await c.query('ALTER TABLE tenants OWNER TO tmp_owner_test');
        await c.query('ALTER FUNCTION app_resolve_tenant(text) OWNER TO tmp_owner_test');
        await c.query('SET LOCAL ROLE invoice_app');
        const { rows } = await c.query("SELECT app_resolve_tenant('acme') AS id");
        expect(rows[0].id).toBe(ACME);
        expect((await c.query('SELECT * FROM tenants')).rows).toEqual([]);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });

  describe('TenantDbService with real Drizzle', () => {
    it('scopes queries to the tenant and rolls back on error', async () => {
      const svc = new TenantDbService(drizzle(app, { schema }));
      const names = await svc.run(GLOBEX, (tx) => tx.select().from(schema.tenants));
      expect(names.map((t) => t.alias)).toEqual(['globex']);

      await expect(
        svc.run(ACME, async (tx) => {
          await tx
            .insert(schema.auditLogs)
            .values({ tenantId: ACME, action: 'int-test.rolled-back' });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      const { rows } = await owner.query(
        `SELECT 1 FROM audit_logs WHERE action = 'int-test.rolled-back'`,
      );
      expect(rows).toEqual([]);
    });

    it('the transaction-local setting is gone once run() returns', async () => {
      const svc = new TenantDbService(drizzle(app, { schema }));
      await svc.run(ACME, (tx) => tx.execute(sql`select 1`));
      const { rows } = await app.query('SELECT * FROM tenants');
      expect(rows).toEqual([]);
    });
  });
});
