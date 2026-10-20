/**
 * DocumentsService.create against a REAL Postgres as the real app role: the same file or the same
 * Idempotency-Key sent again must leave one document and report `created` exactly once (the queue,
 * T2.4, starts a job only then). Files are real, in a LocalFs test root.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { TenantDbService } from '../src/db/tenant-db.service';
import * as schema from '../src/db/schema';
import {
  DocumentsService,
  type CreateDocumentResult,
} from '../src/modules/documents/application/documents.service';
import type { UploadedObject } from '../src/modules/documents/infra/storage-multer-engine';
import { LocalFsStorage } from '../src/modules/storage/infra/local-fs.storage';
import { useTestRoots } from '../src/modules/storage/testing/test-root';
import { tablesWithoutRls } from './support/rls';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const USER = '00000000-0000-4000-8000-00000000f003';

const newRoot = useTestRoots();

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

describe('documents create: dedupe + Idempotency-Key (Postgres, LocalFs)', () => {
  let owner: Pool;
  let app: Pool;
  let storage: LocalFsStorage;
  let service: DocumentsService;
  let tenantDb: TenantDbService;
  let seq = 0;

  /** Writes a distinct PDF-like file the way the upload engine does and describes it. */
  async function stored(tenant: string, content: string): Promise<UploadedObject> {
    const storageKey = `tenant/${tenant}/${(seq++).toString().padStart(8, '0')}-0000-4000-8000-000000000000`;
    const body = Buffer.from(`%PDF-1.7\n${content}\n`);
    const { size, sha256 } = await storage.put(storageKey, Readable.from([body]));
    return { storageKey, size, sha256, sourceType: 'pdf' };
  }
  const create = (tenant: string, key: string, file: UploadedObject, ip?: string) =>
    service.create({ tenantId: tenant, userId: USER, ip, idempotencyKey: key, file });
  const exists = async (file: UploadedObject) => (await storage.stat(file.storageKey)) !== null;
  const count = async (table: string, where = 'true') =>
    (await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0]
      .n as number;

  async function clean() {
    await owner.query('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1)', [[ACME, GLOBEX]]);
    await owner.query(
      `DELETE FROM audit_logs WHERE entity = 'document' AND entity_id IN
         (SELECT id FROM documents WHERE uploaded_by = $1)`,
      [USER],
    );
    await owner.query('DELETE FROM documents WHERE uploaded_by = $1', [USER]);
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 1 });
    app = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 8 });
    tenantDb = new TenantDbService(drizzle(app, { schema }));
    storage = new LocalFsStorage(await newRoot());
    service = new DocumentsService(tenantDb, storage);
  });
  afterAll(async () => {
    await clean();
    await Promise.all([owner.end(), app.end()]);
  });
  beforeEach(clean);

  it('has forced RLS and a policy on every public table, idempotency_keys included', async () => {
    expect(await tablesWithoutRls(owner)).toEqual([]);
  });

  it('creates the document, one audit row with the caller ip, status uploaded v1', async () => {
    const file = await stored(ACME, 'one');
    const res = await create(ACME, 'k1', file, '203.0.113.7');
    expect(res).toMatchObject({ created: true, replayed: false, statusCode: 201 });
    expect(res.document).toMatchObject({
      status: 'uploaded',
      version: 1,
      sourceType: 'pdf',
      contentHash: file.sha256,
    });
    expect(res.document).not.toHaveProperty('storageKey');
    const { rows } = await owner.query(
      `SELECT actor_id, host(ip) AS ip, meta FROM audit_logs WHERE entity_id = $1`,
      [res.document.id],
    );
    expect(rows).toEqual([{ actor_id: USER, ip: '203.0.113.7', meta: { sourceType: 'pdf' } }]);
    expect(await exists(file)).toBe(true);
  });

  it('the same request twice (same key, same file) -> one row, one create, same answer', async () => {
    const first = await create(ACME, 'k1', await stored(ACME, 'dup'));
    const again = await stored(ACME, 'dup');
    const second = await create(ACME, 'k1', again);

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, replayed: true, statusCode: 201 });
    expect(second.document).toEqual(first.document);
    expect(await count('documents', `uploaded_by = '${USER}'`)).toBe(1);
    expect(await count('audit_logs', `action = 'document.created' AND tenant_id = '${ACME}'`)).toBe(
      1,
    );
    expect(await exists(again)).toBe(false); // the duplicate upload does not stay on disk
  });

  it('the same bytes under a new key -> the existing document, answered 200, no second create', async () => {
    const first = await create(ACME, 'k1', await stored(ACME, 'same-bytes'));
    const dupFile = await stored(ACME, 'same-bytes');
    const second = await create(ACME, 'k2', dupFile);

    expect(second).toMatchObject({ created: false, replayed: false, statusCode: 200 });
    expect(second.document.id).toBe(first.document.id);
    expect(await count('documents', `uploaded_by = '${USER}'`)).toBe(1);
    expect(await count('audit_logs', `action = 'document.created' AND tenant_id = '${ACME}'`)).toBe(
      1,
    );
    expect(await exists(dupFile)).toBe(false);
  });

  it('the original file survives a duplicate upload', async () => {
    const original = await stored(ACME, 'keep-me');
    await create(ACME, 'k1', original);
    await create(ACME, 'k2', await stored(ACME, 'keep-me'));
    expect(await exists(original)).toBe(true);
  });

  it('a key replayed after a duplicate keeps the original status code (200)', async () => {
    await create(ACME, 'k1', await stored(ACME, 'orig'));
    const dup = await create(ACME, 'k2', await stored(ACME, 'orig'));
    const replay = await create(ACME, 'k2', await stored(ACME, 'orig'));
    expect(dup.statusCode).toBe(200);
    expect(replay).toMatchObject({ created: false, replayed: true, statusCode: 200 });
  });

  it('the same key with a different file -> 422 IDEMPOTENCY_KEY_REUSED and nothing is kept', async () => {
    await create(ACME, 'k1', await stored(ACME, 'first'));
    const other = await stored(ACME, 'second');
    const err = await create(ACME, 'k1', other).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await count('documents', `uploaded_by = '${USER}'`)).toBe(1);
    expect(await exists(other)).toBe(false);
  });

  it('five identical requests at once -> exactly one creates', async () => {
    const files = await Promise.all([1, 2, 3, 4, 5].map(() => stored(ACME, 'race')));
    const results = await Promise.all(files.map((f) => create(ACME, 'race-key', f)));

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.document.id)).size).toBe(1);
    expect(await count('documents', `uploaded_by = '${USER}'`)).toBe(1);
    expect(await count('audit_logs', `action = 'document.created' AND tenant_id = '${ACME}'`)).toBe(
      1,
    );
    expect(await count('idempotency_keys', `tenant_id = '${ACME}'`)).toBe(1);
    expect((await Promise.all(files.map(exists))).filter(Boolean)).toHaveLength(1);
  });

  it('five same-file requests with different keys at once -> exactly one creates', async () => {
    const files = await Promise.all([1, 2, 3, 4, 5].map(() => stored(ACME, 'race2')));
    const results: CreateDocumentResult[] = await Promise.all(
      files.map((f, i) => create(ACME, `key-${i}`, f)),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await count('documents', `uploaded_by = '${USER}'`)).toBe(1);
    expect(await count('idempotency_keys', `tenant_id = '${ACME}'`)).toBe(5);
  });

  it('two tenants: same key and same bytes give two separate documents', async () => {
    const a = await create(ACME, 'shared-key', await stored(ACME, 'cross'));
    const b = await create(GLOBEX, 'shared-key', await stored(GLOBEX, 'cross'));

    expect(a.created && b.created).toBe(true);
    expect(a.document.id).not.toBe(b.document.id);
  });

  it("a tenant cannot see another tenant's keys (RLS)", async () => {
    await create(ACME, 'secret-key', await stored(ACME, 'rls'));
    const seen = await tenantDb.run(GLOBEX, (tx) => tx.select().from(schema.idempotencyKeys));
    expect(seen).toEqual([]);
  });

  it('a key older than 24 h no longer replays: it is replaced by the new request', async () => {
    const first = await create(ACME, 'old-key', await stored(ACME, 'aged'));
    await owner.query(
      `UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = 'old-key'`,
    );
    // Before it expired this would have been a replay; the different file shows it is not one now.
    const fresh = await create(ACME, 'old-key', await stored(ACME, 'brand-new'));

    expect(fresh).toMatchObject({ created: true, replayed: false });
    expect(fresh.document.id).not.toBe(first.document.id);
    expect(await count('idempotency_keys', `tenant_id = '${ACME}'`)).toBe(1);
  });

  it('a failed request leaves no document, no key and no file', async () => {
    await create(ACME, 'k1', await stored(ACME, 'base'));
    const bad = await stored(ACME, 'bad');
    await expect(create(ACME, 'k1', bad)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await count('idempotency_keys', `tenant_id = '${ACME}'`)).toBe(1);
    expect(await exists(bad)).toBe(false);
  });

  it('an error after COMMIT keeps the file: the committed document must not lose it', async () => {
    const file = await stored(ACME, 'commit-then-fail');
    const dropped = new TenantDbService(drizzle(app, { schema }));
    const realRun = dropped.run.bind(dropped);
    // The transaction commits, then the caller sees a failure (e.g. connection reset on the ack).
    dropped.run = async (...args: Parameters<typeof realRun>) => {
      await realRun(...args);
      throw new Error('connection reset');
    };
    const flaky = new DocumentsService(dropped, storage);

    await expect(
      flaky.create({ tenantId: ACME, userId: USER, ip: undefined, idempotencyKey: 'k1', file }),
    ).rejects.toThrow('connection reset');
    expect(await count('documents', `uploaded_by = '${USER}'`)).toBe(1);
    expect(await exists(file)).toBe(true);
    // The client retries with the same key and bytes and gets the document, whose file exists.
    const retry = await create(ACME, 'k1', await stored(ACME, 'commit-then-fail'));
    expect(retry).toMatchObject({ created: false, replayed: true });
    expect(await exists(file)).toBe(true);
  });

  it('a failing storage.delete does not hide the result', async () => {
    const brokenStorage = Object.create(storage) as LocalFsStorage;
    brokenStorage.delete = () => Promise.reject(new Error('disk gone'));
    const svc = new DocumentsService(tenantDb, brokenStorage);
    await create(ACME, 'k1', await stored(ACME, 'del-fail'));
    const res = await svc.create({
      tenantId: ACME,
      userId: USER,
      ip: undefined,
      idempotencyKey: 'k2',
      file: await stored(ACME, 'del-fail'),
    });
    expect(res).toMatchObject({ created: false, statusCode: 200 });
  });
});
