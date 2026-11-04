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
const GLOBEX = '00000000-0000-4000-8000-0000000000b1';
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
            // Token "<role>" (tenant acme) or "<role>@<tenant alias>".
            verify: (token: string) => {
              const [role, alias = 'acme'] = token.split('@');
              return Promise.resolve({
                sub: USER,
                organization: [alias],
                realm_access: { roles: [role] },
              });
            },
          },
        },
        {
          provide: TENANT_DIRECTORY,
          useValue: { idForAlias: (a: string) => Promise.resolve(a === 'globex' ? GLOBEX : ACME) },
        },
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

  describe('GET /documents/:id/file', () => {
    const get = (id: string, who = 'viewer') =>
      request(app.getHttpServer())
        .get(`/documents/${id}/file`)
        .set('Authorization', `Bearer ${who}`);
    const xml = Buffer.from('<?xml version="1.0"?><HDon><!-- SAMPLE --></HDon>');

    it('streams the stored bytes with inert headers; a viewer may read', async () => {
      const up = await post(pdf('file-1'), 'f1').expect(201);
      const res = await get(up.body.id).expect(200);

      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe('sandbox');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.from(res.body as Buffer).equals(pdf('file-1'))).toBe(true);
    });

    it('serves XML as text/plain, never as markup', async () => {
      const up = await request(app.getHttpServer())
        .post('/documents/upload')
        .set('Authorization', 'Bearer accountant')
        .set('Idempotency-Key', 'fx')
        .attach('file', xml, { filename: 'a.xml', contentType: 'application/xml' })
        .expect(201);
      const res = await get(up.body.id).expect(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.text).toContain('<HDon>');
    });

    it('another tenant, a malformed id, an unknown id: 404; no token: 401', async () => {
      const up = await post(pdf('file-2'), 'f2').expect(201);
      await get(up.body.id, 'tenant_admin@globex').expect(404);
      await get('not-a-uuid').expect(404);
      await get('00000000-0000-4000-8000-00000000dead').expect(404);
      await request(app.getHttpServer()).get(`/documents/${up.body.id}/file`).expect(401);
    });

    it('a row whose bytes are gone is 404, not a 500', async () => {
      const up = await post(pdf('file-3'), 'f3').expect(201);
      await rm(path.join(root, 'tenant'), { recursive: true, force: true });
      await get(up.body.id).expect(404);
    });
  });
});
