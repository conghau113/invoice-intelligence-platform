/**
 * POST /documents/upload end to end: real guards, multer engine, LocalFs, DocumentsService and
 * Postgres (as the app role). Only token verification is stubbed. Proves the spec check "send the
 * same request twice -> one row" through HTTP, including status codes, the replay header and files.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { ProblemDetailsFilter } from '../src/common/http/problem-details.filter';
import * as schema from '../src/db/schema';
import { DB, TenantDbService } from '../src/db/tenant-db.service';
import { TenantTransactionInterceptor } from '../src/db/tenant-transaction.interceptor';
import { TENANT_DIRECTORY } from '../src/modules/auth/application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../src/modules/auth/application/token-verifier.port';
import { JwtAuthGuard } from '../src/modules/auth/http/jwt-auth.guard';
import { PermissionsGuard } from '../src/modules/auth/http/permissions.guard';
import { DocumentsModule } from '../src/modules/documents/documents.module';
import { EXTRACTION_QUEUE_PORT } from '../src/modules/queue/application/extraction-queue.port';
import { FakeExtractionQueue } from '../src/modules/queue/testing/fake-extraction-queue';
import { STORAGE_PORT } from '../src/modules/storage/application/storage.port';
import { LocalFsStorage } from '../src/modules/storage/infra/local-fs.storage';
import { useTestRoots } from '../src/modules/storage/testing/test-root';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-00000000f004';
const newRoot = useTestRoots();

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

const pdf = (text: string) => Buffer.from(`%PDF-1.7\n${text}\n`);

describe('POST /documents/upload (HTTP -> Postgres -> LocalFs)', () => {
  let owner: Pool;
  let pool: Pool;
  let app: INestApplication;
  let root: string;

  const files = async () =>
    (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
  const rows = async () =>
    (await owner.query('SELECT count(*)::int AS n FROM documents WHERE uploaded_by = $1', [USER]))
      .rows[0].n as number;
  const post = (body: Buffer, key?: string, auth = 'Bearer accountant') => {
    const req = request(app.getHttpServer()).post('/documents/upload').set('Authorization', auth);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.attach('file', body, { filename: 'a.pdf', contentType: 'application/pdf' });
  };

  async function clean() {
    await rm(path.join(root, 'tenant'), { recursive: true, force: true });
    await owner.query('DELETE FROM idempotency_keys WHERE tenant_id = $1', [ACME]);
    await owner.query(
      `DELETE FROM audit_logs WHERE entity = 'document' AND entity_id IN
         (SELECT id FROM documents WHERE uploaded_by = $1)`,
      [USER],
    );
    await owner.query('DELETE FROM documents WHERE uploaded_by = $1', [USER]);
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 1 });
    pool = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 4 });
    root = await newRoot();

    @Global()
    @Module({
      providers: [
        { provide: DB, useValue: drizzle(pool, { schema }) },
        TenantDbService,
        { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
      ],
      exports: [DB, TenantDbService],
    })
    class RealDbModule {}

    const mod = await Test.createTestingModule({
      imports: [RealDbModule, DocumentsModule],
      providers: [
        {
          provide: TOKEN_VERIFIER,
          useValue: {
            verify: (token: string) =>
              Promise.resolve({
                sub: USER,
                organization: ['acme'],
                realm_access: { roles: [token] },
              }),
          },
        },
        { provide: TENANT_DIRECTORY, useValue: { idForAlias: () => Promise.resolve(ACME) } },
        { provide: ConfigService, useValue: {} },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    })
      .overrideProvider(STORAGE_PORT)
      .useValue(new LocalFsStorage(root))
      .overrideProvider(EXTRACTION_QUEUE_PORT)
      .useValue(new FakeExtractionQueue())
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await clean();
    await Promise.all([owner.end(), pool.end()]);
  });
  beforeEach(clean);

  it('same request twice -> 201 then 201 replayed; one row, one file', async () => {
    const first = await post(pdf('x'), 'k1').expect(201);
    const second = await post(pdf('x'), 'k1').expect(201);

    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(first.body).not.toHaveProperty('storageKey');
    expect(await rows()).toBe(1);
    expect(await files()).toHaveLength(1);
  });

  it('same bytes under a new key -> 200 with the existing document; still one row, one file', async () => {
    const first = await post(pdf('y'), 'k1').expect(201);
    const dup = await post(pdf('y'), 'k2').expect(200);

    expect(dup.body.id).toBe(first.body.id);
    expect(dup.headers['idempotent-replayed']).toBeUndefined();
    expect(await rows()).toBe(1);
    expect(await files()).toHaveLength(1);
  });

  it('same key with another file -> 422 IDEMPOTENCY_KEY_REUSED, nothing extra stored', async () => {
    await post(pdf('a'), 'k1').expect(201);
    const res = await post(pdf('b'), 'k1').expect(422);

    expect(res.body).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await rows()).toBe(1);
    expect(await files()).toHaveLength(1);
  });

  it('no Idempotency-Key -> 400 and no file is written; no token -> 401 first', async () => {
    const res = await post(pdf('z')).expect(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await files()).toHaveLength(0);
    await request(app.getHttpServer())
      .post('/documents/upload')
      .attach('file', pdf('z'), 'a.pdf')
      .expect(401);
  });
});
