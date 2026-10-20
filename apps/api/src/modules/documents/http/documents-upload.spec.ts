import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
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
import { DocumentsModule, MAX_UPLOAD_BYTES } from '../documents.module';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const newRoot = useTestRoots();

async function files(dir: string): Promise<string[]> {
  const all = await readdir(dir, { recursive: true, withFileTypes: true });
  return all.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);

describe('POST /documents/upload (real guards, filter, multer engine and LocalFs)', () => {
  let app: INestApplication;
  let root: string;

  beforeEach(async () => {
    root = await newRoot();
    const verifier = {
      verify: (token: string) =>
        Promise.resolve({
          sub: USER_ID,
          organization: [token.endsWith('@globex') ? 'globex' : 'acme'],
          realm_access: { roles: [token.split('@')[0]] },
        }),
    };
    const mod = await Test.createTestingModule({
      imports: [DocumentsModule],
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
      ],
    })
      .overrideProvider(STORAGE_PORT)
      .useValue(new LocalFsStorage(root))
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(() => app.close());

  const upload = (content: Buffer, filename = 'invoice.pdf', role = 'accountant') =>
    request(app.getHttpServer())
      .post('/documents/upload')
      .set('Authorization', `Bearer ${role}`)
      .attach('file', content, { filename, contentType: 'application/pdf' });

  it('stores a valid PDF under tenant/<id>/<uuid> and reports key, size, sha256, type', async () => {
    const res = await upload(PDF).expect(201);
    expect(res.body).toMatchObject({ size: PDF.length, sourceType: 'pdf' });
    expect(res.body.storageKey).toMatch(new RegExp(`^tenant/${TENANT_ID}/[0-9a-f-]{36}$`));
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [stored] = await files(root);
    expect(await readFile(stored as string)).toEqual(PDF);
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
    const res = await upload(exact).expect(201);
    expect(res.body.size).toBe(MAX_UPLOAD_BYTES);
  });

  it('a hostile file name never reaches the storage path', async () => {
    const res = await upload(PDF, '../../etc/passwd').expect(201);
    expect(res.body.storageKey).toMatch(new RegExp(`^tenant/${TENANT_ID}/[0-9a-f-]{36}$`));
    const stored = await files(root);
    expect(stored).toHaveLength(1);
    expect((stored[0] as string).startsWith(root + path.sep)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('passwd');
  });

  it("each tenant's upload lands under its own prefix", async () => {
    const a = await upload(PDF).expect(201);
    const b = await upload(PDF, 'invoice.pdf', 'accountant@globex').expect(201);
    expect(a.body.storageKey).toMatch(new RegExp(`^tenant/${TENANT_ID}/`));
    expect(b.body.storageKey).toMatch(new RegExp(`^tenant/${OTHER_TENANT_ID}/`));
    expect(a.body.storageKey).not.toBe(b.body.storageKey);
  });

  it('no file part -> 400', async () => {
    await request(app.getHttpServer())
      .post('/documents/upload')
      .set('Authorization', 'Bearer accountant')
      .field('note', 'hi')
      .expect(400);
  });

  it('two files -> refused, nothing stored', async () => {
    const res = await request(app.getHttpServer())
      .post('/documents/upload')
      .set('Authorization', 'Bearer accountant')
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
