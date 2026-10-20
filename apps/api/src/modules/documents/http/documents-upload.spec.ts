import { TenantDbService } from '../../../db/tenant-db.service';
import { TenantTransactionInterceptor } from '../../../db/tenant-transaction.interceptor';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { ProblemDetailsFilter } from '../../../common/http/problem-details.filter';
import { TENANT_DIRECTORY } from '../../auth/application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../../auth/application/token-verifier.port';
import { JwtAuthGuard } from '../../auth/http/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/http/permissions.guard';
import { STORAGE_PORT } from '../../storage/application/storage.port';
import { LocalFsStorage } from '../../storage/infra/local-fs.storage';
import { useTestRoots } from '../../storage/testing/test-root';
import type { CreateDocumentInput, CreateDocumentResult } from '../application/documents.service';
import { DocumentsService } from '../application/documents.service';
import { DocumentsModule, MAX_UPLOAD_BYTES } from '../documents.module';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
// DbModule is global in the app; this test never touches the database. `run` only counts calls so
// a test can tell whether the request-wide tenant transaction was opened.
const tenantTransactions: string[] = [];
@Global()
@Module({
  providers: [
    {
      provide: TenantDbService,
      useValue: {
        run: (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
          tenantTransactions.push(tenantId);
          return fn({});
        },
      },
    },
  ],
  exports: [TenantDbService],
})
class FakeDbModule {}

const USER_ID = '22222222-2222-4222-8222-222222222222';
const newRoot = useTestRoots();

async function files(dir: string): Promise<string[]> {
  const all = await readdir(dir, { recursive: true, withFileTypes: true });
  return all.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

/**
 * Stands in for the database-backed service (covered by test/documents-create.int-spec.ts): this
 * spec is about what the HTTP layer does with the request, the guard, multer and LocalFs.
 */
class FakeDocumentsService {
  calls: CreateDocumentInput[] = [];
  next: Partial<CreateDocumentResult> = {};

  create(input: CreateDocumentInput): Promise<CreateDocumentResult> {
    this.calls.push(input);
    return Promise.resolve({
      document: {
        id: DOC_ID,
        status: 'uploaded',
        sourceType: input.file.sourceType,
        contentHash: input.file.sha256,
        version: 1,
        createdAt: new Date('2026-10-20T00:00:00Z'),
      },
      created: true,
      statusCode: 201,
      replayed: false,
      ...this.next,
    });
  }
}

const DOC_ID = '44444444-4444-4444-8444-444444444444';
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);

describe('POST /documents/upload (real guards, filter, multer engine and LocalFs)', () => {
  let app: INestApplication;
  let root: string;
  let service: FakeDocumentsService;

  beforeEach(async () => {
    root = await newRoot();
    service = new FakeDocumentsService();
    tenantTransactions.length = 0;
    const verifier = {
      verify: (token: string) =>
        Promise.resolve({
          sub: USER_ID,
          organization: [token.endsWith('@globex') ? 'globex' : 'acme'],
          realm_access: { roles: [token.split('@')[0]] },
        }),
    };
    const mod = await Test.createTestingModule({
      imports: [FakeDbModule, DocumentsModule],
      providers: [
        { provide: TOKEN_VERIFIER, useValue: verifier },
        {
          provide: TENANT_DIRECTORY,
          useValue: {
            idForAlias: (a: string) =>
              Promise.resolve(a === 'globex' ? OTHER_TENANT_ID : TENANT_ID),
          },
        },
        { provide: ConfigService, useValue: {} },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
      ],
    })
      .overrideProvider(DocumentsService)
      .useValue(service)
      .overrideProvider(STORAGE_PORT)
      .useValue(new LocalFsStorage(root))
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(() => app.close());

  const upload = (content: Buffer, filename = 'invoice.pdf', role = 'accountant', key = 'key-1') =>
    request(app.getHttpServer())
      .post('/documents/upload')
      .set('Authorization', `Bearer ${role}`)
      .set('Idempotency-Key', key)
      .attach('file', content, { filename, contentType: 'application/pdf' });

  it('stores a valid PDF and hands the service its key, size, hash, type and tenant', async () => {
    const res = await upload(PDF).expect(201);
    expect(res.body).toMatchObject({ id: DOC_ID, status: 'uploaded', sourceType: 'pdf' });
    expect(res.body).not.toHaveProperty('storageKey');
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    const [call] = service.calls;
    expect(call).toMatchObject({
      tenantId: TENANT_ID,
      userId: USER_ID,
      idempotencyKey: 'key-1',
      file: { size: PDF.length, sourceType: 'pdf' },
    });
    expect(call?.file.storageKey).toMatch(new RegExp(`^tenant/${TENANT_ID}/[0-9a-f-]{36}$`));
    expect(call?.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [stored] = await files(root);
    expect(await readFile(stored as string)).toEqual(PDF);
  });

  it('does not hold a tenant transaction open while the file streams in', async () => {
    await upload(PDF).expect(201);
    expect(tenantTransactions).toEqual([]);
  });

  it('an existing document answers 200 and a replay by key adds Idempotent-Replayed', async () => {
    service.next = { created: false, statusCode: 200, replayed: false };
    const dup = await upload(PDF).expect(200);
    expect(dup.headers['idempotent-replayed']).toBeUndefined();
    service.next = { created: false, statusCode: 201, replayed: true };
    const replay = await upload(PDF).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['with a space', 'a b'],
    ['over 255 characters', 'k'.repeat(256)],
  ])('an Idempotency-Key that is %s -> 400 before the body is written', async (_name, key) => {
    const req = request(app.getHttpServer())
      .post('/documents/upload')
      .set('Authorization', 'Bearer accountant');
    if (key !== undefined) req.set('Idempotency-Key', key);
    const res = await req.attach('file', PDF, 'a.pdf').expect(400);
    expect(res.body).toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(await files(root)).toEqual([]);
    expect(service.calls).toEqual([]);
  });

  it('accepts a tiny XML (shorter than the sniff window)', async () => {
    const res = await upload(Buffer.from('<a/>'), 'inv.xml').expect(201);
    expect(res.body.sourceType).toBe('xml');
  });

  it('an .exe renamed .pdf is refused with 415 and nothing is written', async () => {
    const res = await upload(EXE, 'totally-a.pdf').expect(415);
    expect(res.body).toMatchObject({ status: 415, code: 'UNSUPPORTED_FILE_TYPE' });
    expect(await files(root)).toEqual([]);
  });

  it('a file over 10 MiB is refused with 413 and nothing is left on disk', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_UPLOAD_BYTES + 1 - PDF.length)]);
    expect(big).toHaveLength(MAX_UPLOAD_BYTES + 1);
    await upload(big).expect(413);
    expect(await files(root)).toEqual([]);
  });

  it('a file of exactly 10 MiB is accepted', async () => {
    const exact = Buffer.concat([PDF, Buffer.alloc(MAX_UPLOAD_BYTES - PDF.length)]);
    await upload(exact).expect(201);
    expect(service.calls[0]?.file.size).toBe(MAX_UPLOAD_BYTES);
  });

  it('a hostile file name never reaches the storage path', async () => {
    const res = await upload(PDF, '../../etc/passwd').expect(201);
    expect(service.calls[0]?.file.storageKey).toMatch(
      new RegExp(`^tenant/${TENANT_ID}/[0-9a-f-]{36}$`),
    );
    const stored = await files(root);
    expect(stored).toHaveLength(1);
    expect((stored[0] as string).startsWith(root + path.sep)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('passwd');
  });

  it("each tenant's upload lands under its own prefix", async () => {
    await upload(PDF).expect(201);
    await upload(PDF, 'invoice.pdf', 'accountant@globex').expect(201);
    const [a, b] = service.calls.map((c) => c.file.storageKey);
    expect(a).toMatch(new RegExp(`^tenant/${TENANT_ID}/`));
    expect(b).toMatch(new RegExp(`^tenant/${OTHER_TENANT_ID}/`));
    expect(a).not.toBe(b);
  });

  it('no file part -> 400', async () => {
    await request(app.getHttpServer())
      .post('/documents/upload')
      .set('Authorization', 'Bearer accountant')
      .set('Idempotency-Key', 'key-1')
      .field('note', 'hi')
      .expect(400);
  });

  it('two files -> refused, nothing stored', async () => {
    const res = await request(app.getHttpServer())
      .post('/documents/upload')
      .set('Authorization', 'Bearer accountant')
      .set('Idempotency-Key', 'key-1')
      .attach('file', PDF, 'a.pdf')
      .attach('file', PDF, 'b.pdf');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await files(root)).toEqual([]);
  });

  it('a viewer lacks document:create -> 403 and nothing is read from the body', async () => {
    await upload(PDF, 'a.pdf', 'viewer').expect(403);
    expect(await files(root)).toEqual([]);
  });

  it('no token -> 401', async () => {
    await request(app.getHttpServer())
      .post('/documents/upload')
      .attach('file', PDF, 'a.pdf')
      .expect(401);
  });
});
