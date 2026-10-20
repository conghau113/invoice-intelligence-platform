/**
 * The documents table and DocumentStateMachine against a REAL Postgres as the real app role.
 * The database comes from support/postgres.global-setup.ts (real migrations). Fixtures are inserted
 * with fixed ids and removed afterwards by the owner (the app role cannot DELETE documents).
 */
import { NotFoundException } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DocumentStateMachine } from '../src/modules/documents/application/document-state-machine';
import { InvalidDocumentTransitionError } from '../src/modules/documents/domain/document-status';
import { TenantDbService } from '../src/db/tenant-db.service';
import * as schema from '../src/db/schema';
import { tablesWithoutRls } from './support/rls';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const DOC_A = '00000000-0000-4000-8000-0000000d0001';
const DOC_G = '00000000-0000-4000-8000-0000000d0002';
const USER = '00000000-0000-4000-8000-00000000f001';
const HASH_A = 'a'.repeat(64);
const HASH_G = 'b'.repeat(64);

// Drizzle wraps the pg error in "Failed query"; the real message is on `cause`.
const RLS_VIOLATION = expect.stringMatching(/row-level security/);

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

describe('documents (Postgres, RLS, state machine)', () => {
  let owner: Pool;
  let app: Pool;
  let tenantDb: TenantDbService;
  let machine: DocumentStateMachine;

  const insertDoc = (id: string, tenant: string, hash: string, status = 'uploaded') =>
    owner.query(
      `INSERT INTO documents (id, tenant_id, status, source_type, storage_key, content_hash, uploaded_by)
       VALUES ($1, $2, $3, 'xml', 'tenant/x/y', $4, $5)`,
      [id, tenant, status, hash, USER],
    );
  const statusOf = async (id: string) =>
    (await owner.query('SELECT status, version FROM documents WHERE id = $1', [id])).rows[0];
  const auditCount = async (id: string) =>
    (await owner.query('SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1', [id]))
      .rows[0].n as number;

  async function clean() {
    await owner.query('DELETE FROM audit_logs WHERE entity = $1 AND entity_id = ANY($2)', [
      'document',
      [DOC_A, DOC_G],
    ]);
    await owner.query('DELETE FROM documents WHERE id = ANY($1)', [[DOC_A, DOC_G]]);
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 1 });
    app = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 4 });
    tenantDb = new TenantDbService(drizzle(app, { schema }));
    machine = new DocumentStateMachine(tenantDb);
  });
  afterAll(async () => {
    await clean();
    await Promise.all([owner.end(), app.end()]);
  });
  beforeEach(async () => {
    await clean();
    await insertDoc(DOC_A, ACME, HASH_A);
    await insertDoc(DOC_G, GLOBEX, HASH_G);
  });

  it('has forced RLS and a policy on every public table, documents included', async () => {
    expect(await tablesWithoutRls(owner)).toEqual([]);
  });

  it('shows a tenant only its own documents and refuses cross-tenant inserts', async () => {
    const seen = await tenantDb.run(ACME, (tx) =>
      tx.select({ id: schema.documents.id }).from(schema.documents),
    );
    expect(seen.map((r) => r.id)).toEqual([DOC_A]);

    await expect(
      tenantDb.run(ACME, (tx) =>
        tx.insert(schema.documents).values({
          tenantId: GLOBEX,
          sourceType: 'xml',
          storageKey: 'k',
          contentHash: 'c'.repeat(64),
          uploadedBy: USER,
        }),
      ),
    ).rejects.toHaveProperty('cause.message', RLS_VIOLATION);
  });

  it('returns no rows without a tenant (fail closed)', async () => {
    const { rows } = await app.query('SELECT id FROM documents');
    expect(rows).toEqual([]);
  });

  it('enforces unique (tenant, hash) but allows the same hash in another tenant', async () => {
    await expect(insertDoc('00000000-0000-4000-8000-0000000d0003', ACME, HASH_A)).rejects.toThrow(
      /documents_tenant_hash_unique/,
    );
    await insertDoc('00000000-0000-4000-8000-0000000d0004', GLOBEX, HASH_A);
    await owner.query('DELETE FROM documents WHERE id = $1', [
      '00000000-0000-4000-8000-0000000d0004',
    ]);
  });

  it('rejects values outside the status, source type and hash constraints', async () => {
    await expect(
      insertDoc('00000000-0000-4000-8000-0000000d0005', ACME, 'd'.repeat(64), 'bogus'),
    ).rejects.toThrow(/documents_status_check/);
    await expect(
      insertDoc('00000000-0000-4000-8000-0000000d0005', ACME, 'NOT-A-HASH'),
    ).rejects.toThrow(/documents_content_hash_check/);
    await expect(
      owner.query(
        `INSERT INTO documents (tenant_id, source_type, storage_key, content_hash, uploaded_by)
         VALUES ($1, 'exe', 'k', $2, $3)`,
        [ACME, 'e'.repeat(64), USER],
      ),
    ).rejects.toThrow(/documents_source_type_check/);
  });

  it('lets the app change status/version only: not content_hash, not delete', async () => {
    // Raw client: Drizzle wraps the pg error and hides "permission denied".
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [ACME]);
      await expect(
        c.query('UPDATE documents SET content_hash = $1 WHERE id = $2', ['f'.repeat(64), DOC_A]),
      ).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [ACME]);
      await expect(c.query('DELETE FROM documents WHERE id = $1', [DOC_A])).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('applies a valid transition and writes exactly one audit entry in the same commit', async () => {
    const res = await tenantDb.run(ACME, () =>
      machine.transition(DOC_A, 'queued', { actorId: USER }),
    );
    expect(res).toEqual({ from: 'uploaded', to: 'queued', version: 1 });
    expect(await statusOf(DOC_A)).toEqual({ status: 'queued', version: 1 });
    const { rows } = await owner.query(
      'SELECT tenant_id, actor_id, action, meta FROM audit_logs WHERE entity_id = $1',
      [DOC_A],
    );
    expect(rows).toEqual([
      {
        tenant_id: ACME,
        actor_id: USER,
        action: 'document.status_changed',
        meta: { from: 'uploaded', to: 'queued' },
      },
    ]);
  });

  it('records a system actor (null) and a reason code', async () => {
    await tenantDb.run(ACME, async () => {
      await machine.transition(DOC_A, 'queued', { actorId: null });
      await machine.transition(DOC_A, 'processing', { actorId: null });
      await machine.transition(DOC_A, 'failed', { actorId: null, code: 'AI_UNAVAILABLE' });
    });
    const { rows } = await owner.query(
      'SELECT actor_id, meta FROM audit_logs WHERE entity_id = $1 ORDER BY id DESC LIMIT 1',
      [DOC_A],
    );
    expect(rows[0]).toEqual({
      actor_id: null,
      meta: { from: 'processing', to: 'failed', code: 'AI_UNAVAILABLE' },
    });
  });

  it('bumps version when an approved document is reopened', async () => {
    await owner.query(`UPDATE documents SET status = 'approved' WHERE id = $1`, [DOC_A]);
    const res = await tenantDb.run(ACME, () =>
      machine.transition(DOC_A, 'needs_review', { actorId: USER }),
    );
    expect(res.version).toBe(2);
    expect(await statusOf(DOC_A)).toEqual({ status: 'needs_review', version: 2 });
  });

  it('refuses an invalid transition: status unchanged, no audit entry', async () => {
    await expect(
      tenantDb.run(ACME, () => machine.transition(DOC_A, 'approved', { actorId: USER })),
    ).rejects.toThrow(InvalidDocumentTransitionError);
    expect(await statusOf(DOC_A)).toEqual({ status: 'uploaded', version: 1 });
    expect(await auditCount(DOC_A)).toBe(0);
  });

  it('rolls the status back when the transaction fails after the transition', async () => {
    await expect(
      tenantDb.run(ACME, async () => {
        await machine.transition(DOC_A, 'queued', { actorId: USER });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await statusOf(DOC_A)).toEqual({ status: 'uploaded', version: 1 });
    expect(await auditCount(DOC_A)).toBe(0);
  });

  it("cannot touch another tenant's document (looks like not found)", async () => {
    await expect(
      tenantDb.run(ACME, () => machine.transition(DOC_G, 'queued', { actorId: USER })),
    ).rejects.toThrow(NotFoundException);
    expect(await statusOf(DOC_G)).toEqual({ status: 'uploaded', version: 1 });
  });

  it('lets only one of two concurrent transitions win (row lock, not luck)', async () => {
    await owner.query(`UPDATE documents SET status = 'processing' WHERE id = $1`, [DOC_A]);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let aHoldsLock!: () => void;
    const locked = new Promise<void>((r) => (aHoldsLock = r));
    let releaseA!: () => void;
    const release = new Promise<void>((r) => (releaseA = r));
    // A transitions and keeps its transaction open until B is provably blocked on the row lock.
    // Without FOR UPDATE, B would not block: it would read the stale 'processing'.
    const a = tenantDb.run(ACME, async () => {
      await machine.transition(DOC_A, 'needs_review', { actorId: null });
      aHoldsLock();
      await release;
    });
    await locked;
    const b = tenantDb.run(ACME, () => machine.transition(DOC_A, 'failed', { actorId: null }));
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const { rows } = await owner.query(
        `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%for update%'`,
      );
      blocked = rows.length > 0;
      if (!blocked) await sleep(50);
    }
    releaseA();
    const results = await Promise.allSettled([a, b]);
    expect(blocked).toBe(true);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      InvalidDocumentTransitionError,
    );
    expect(await statusOf(DOC_A)).toEqual({ status: 'needs_review', version: 1 });
    expect(await auditCount(DOC_A)).toBe(1);
  });

  it('refuses to be born in any state but uploaded/version 1 (INSERT cannot skip the machine)', async () => {
    const insertAs = (status: string, version: number) =>
      tenantDb.run(ACME, (tx) =>
        tx.insert(schema.documents).values({
          tenantId: ACME,
          status,
          version,
          sourceType: 'xml',
          storageKey: 'k',
          contentHash: '9'.repeat(64),
          uploadedBy: USER,
        }),
      );
    await expect(insertAs('approved', 1)).rejects.toHaveProperty('cause.message', RLS_VIOLATION);
    await expect(insertAs('uploaded', 2)).rejects.toHaveProperty('cause.message', RLS_VIOLATION);
    const { rows } = await owner.query('SELECT 1 FROM documents WHERE content_hash = $1', [
      '9'.repeat(64),
    ]);
    expect(rows).toEqual([]);
  });

  it('rejects a free-text transition code before touching the database', async () => {
    await expect(
      tenantDb.run(ACME, () =>
        machine.transition(DOC_A, 'queued', { actorId: null, code: 'bad: Nguyen Van A' }),
      ),
    ).rejects.toThrow(/UPPER_SNAKE_CASE/);
    expect(await statusOf(DOC_A)).toEqual({ status: 'uploaded', version: 1 });
  });
});
