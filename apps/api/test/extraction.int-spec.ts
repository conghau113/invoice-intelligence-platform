/**
 * T2.9, the whole slice with real Postgres (app role, RLS) and real Redis in containers:
 * upload an XML -> BullMQ -> worker -> AiExtractionHandler -> HttpAiExtractor -> a local HTTP
 * stand-in for the AI service -> `extractions` -> GET /documents/:id. Only the AI service itself
 * is replaced (it is Python; its own behaviour is covered by pytest) and token verification is
 * stubbed. Covers: data visible after upload, AI down -> retries -> failed with a code the API
 * returns, permanent AI errors fail at once, idempotent re-delivery, tenant isolation.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { Env } from '../src/config/env.schema';
import { ProblemDetailsFilter } from '../src/common/http/problem-details.filter';
import * as schema from '../src/db/schema';
import { DB, TenantDbService } from '../src/db/tenant-db.service';
import { TenantTransactionInterceptor } from '../src/db/tenant-transaction.interceptor';
import { TENANT_DIRECTORY } from '../src/modules/auth/application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../src/modules/auth/application/token-verifier.port';
import { JwtAuthGuard } from '../src/modules/auth/http/jwt-auth.guard';
import { PermissionsGuard } from '../src/modules/auth/http/permissions.guard';
import { DocumentStateMachine } from '../src/modules/documents/application/document-state-machine';
import { DocumentsModule } from '../src/modules/documents/documents.module';
import { AiExtractionHandler } from '../src/modules/extraction/application/ai-extraction.handler';
import { ExtractionModule } from '../src/modules/extraction/extraction.module';
import { HttpAiExtractor } from '../src/modules/extraction/infra/http-ai-extractor';
import { ExtractionProcessor } from '../src/modules/queue/application/extraction.processor';
import { ExtractionWorker } from '../src/modules/queue/infra/extraction-worker';
import { QueueAdminModule } from '../src/modules/queue/queue-admin.module';
import { STORAGE_PORT } from '../src/modules/storage/application/storage.port';
import { LocalFsStorage } from '../src/modules/storage/infra/local-fs.storage';
import { useTestRoots } from '../src/modules/storage/testing/test-root';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const USER = '00000000-0000-4000-8000-00000000f005';
const AI_TOKEN = 'integration-token-0123456789';
const newRoot = useTestRoots();

const INVOICE = JSON.parse(
  readFileSync(
    path.join(__dirname, '../../../packages/contracts/fixtures/invoice.valid.json'),
    'utf8',
  ),
) as { invoiceNo: string; total: number };
const XML = readFileSync(
  path.join(__dirname, '../../ai/tests/fixtures/xml_invoices/invoice-00.xml'),
);

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type AiMode =
  | 'ok'
  | 'down'
  | 'unauthorized'
  | 'unavailable'
  | 'malformed'
  | 'not-implemented'
  | 'garbage'
  // The LLM path as the AI service answers it (usage block, error codes of apps/ai).
  | 'llm-ok'
  | 'llm-inconsistent' // 200 with an invoice whose total is wrong and whose date is in the future
  | 'llm-flaky' // 503 LLM_UNAVAILABLE twice, then llm-ok
  | 'llm-unavailable'
  | 'llm-rate-limited'
  | 'llm-rejected';

const USAGE = {
  model: 'gemini-test',
  promptVersion: 'invoice_extraction/v1',
  inputTokens: 1500,
  outputTokens: 800,
  latencyMs: 3200,
  costUsd: 0.001634,
};

describe('extraction slice (upload -> worker -> AI service -> GET /documents/:id)', () => {
  let owner: Pool;
  let pool: Pool;
  let redis: StartedTestContainer;
  let root: string;
  let ai: Server;
  let live: INestApplication;
  let worker: ExtractionWorker;
  let handler: AiExtractionHandler;
  let tenantDb: TenantDbService;

  // What the stand-in AI service saw and how it should answer.
  let mode: AiMode = 'ok';
  let aiCalls: { authorization?: string; body: Buffer; sourceType: string }[] = [];

  const env = (): Partial<Env> => ({
    AI_SERVICE_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
    AI_SERVICE_TOKEN: AI_TOKEN,
  });
  const config = (redisUrl: string) => ({
    get: (key: string) =>
      ({ REDIS_URL: redisUrl, QUEUE_BACKOFF_BASE_MS: 10, DATA_DIR: root, ...env() })[
        key
      ] as unknown,
  });

  async function makeApp(redisUrl: string): Promise<INestApplication> {
    @Global()
    @Module({
      providers: [
        { provide: DB, useValue: drizzle(pool, { schema }) },
        TenantDbService,
        { provide: ConfigService, useValue: config(redisUrl) },
        { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
      ],
      exports: [DB, TenantDbService, ConfigService],
    })
    class RealDbModule {}

    const mod = await Test.createTestingModule({
      imports: [RealDbModule, DocumentsModule, ExtractionModule, QueueAdminModule],
      providers: [
        {
          provide: TOKEN_VERIFIER,
          useValue: {
            // Token "<role>@<tenant alias>".
            verify: (token: string) => {
              const [role, alias] = token.split('@');
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
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    })
      .overrideProvider(STORAGE_PORT)
      .useValue(new LocalFsStorage(root))
      .compile();
    const app = mod.createNestApplication();
    await app.init();
    return app;
  }

  const upload = (content: Buffer, name: string, type: string, key: string) =>
    request(live.getHttpServer())
      .post('/documents/upload')
      .set('Authorization', 'Bearer accountant@acme')
      .set('Idempotency-Key', key)
      .attach('file', content, { filename: name, contentType: type });
  const uploadXml = (key: string, tag = key) =>
    upload(Buffer.concat([XML, Buffer.from(`<!-- ${tag} -->`)]), 'a.xml', 'application/xml', key);
  const get = (id: string, who = 'accountant@acme') =>
    request(live.getHttpServer()).get(`/documents/${id}`).set('Authorization', `Bearer ${who}`);

  const statusOf = async (id: string) =>
    (await owner.query('SELECT status FROM documents WHERE id = $1', [id])).rows[0]?.status;
  async function waitForStatus(id: string, want: string, ms = 8_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if ((await statusOf(id)) === want) return;
      await sleep(25);
    }
    throw new Error(`document did not reach ${want}, is ${await statusOf(id)}`);
  }
  const extractionCount = async (id: string) =>
    (await owner.query('SELECT count(*)::int AS n FROM extractions WHERE document_id = $1', [id]))
      .rows[0].n as number;

  async function reset(): Promise<void> {
    await rm(path.join(root, 'tenant'), { recursive: true, force: true });
    await owner.query(
      'DELETE FROM extractions WHERE document_id IN (SELECT id FROM documents WHERE uploaded_by = $1)',
      [USER],
    );
    await owner.query('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1)', [[ACME, GLOBEX]]);
    await owner.query(
      `DELETE FROM audit_logs WHERE entity = 'document' AND entity_id IN
         (SELECT id FROM documents WHERE uploaded_by = $1)`,
      [USER],
    );
    await owner.query('DELETE FROM documents WHERE uploaded_by = $1', [USER]);
    mode = 'ok';
    aiCalls = [];
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 1 });
    pool = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 8 });
    root = await newRoot();

    ai = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('latin1');
        aiCalls.push({
          authorization: req.headers.authorization,
          body,
          sourceType: /name="sourceType"\r\n\r\n(\w+)/.exec(text)?.[1] ?? '',
        });
        const json = (status: number, payload: unknown) =>
          res
            .writeHead(status, { 'content-type': 'application/json' })
            .end(JSON.stringify(payload));
        if (mode === 'down') return void req.socket.destroy();
        if (mode === 'unauthorized')
          return json(401, { code: 'SERVICE_UNAUTHORIZED', message: 'x' });
        if (mode === 'unavailable') return json(503, { detail: 'busy' });
        if (mode === 'malformed') return json(422, { code: 'XML_MALFORMED', message: 'x' });
        if (mode === 'not-implemented')
          return json(501, { code: 'EXTRACTION_PATH_NOT_IMPLEMENTED' });
        if (mode === 'garbage')
          return json(200, { invoice: { total: 'lots' }, warnings: [], usage: null });
        if (mode === 'llm-unavailable') return json(503, { code: 'LLM_UNAVAILABLE', message: 'x' });
        if (mode === 'llm-rate-limited')
          return json(429, { code: 'LLM_RATE_LIMITED', message: 'x' });
        if (mode === 'llm-rejected') return json(422, { code: 'PDF_INVALID', message: 'x' });
        if (mode === 'llm-flaky' && aiCalls.length <= 2)
          return json(500, { code: 'LLM_UNAVAILABLE', message: 'x' });
        if (mode === 'llm-inconsistent')
          return json(200, {
            invoice: { ...INVOICE, total: 0, issueDate: '2999-01-01' },
            warnings: [],
            usage: USAGE,
          });
        if (mode === 'llm-ok' || mode === 'llm-flaky')
          return json(200, { invoice: INVOICE, warnings: [], usage: USAGE });
        json(200, { invoice: INVOICE, warnings: [], usage: null });
      });
    });
    await new Promise<void>((r) => ai.listen(0, '127.0.0.1', r));

    redis = await new GenericContainer('redis:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

    live = await makeApp(redisUrl);
    tenantDb = live.get(TenantDbService);
    // The worker side as src/worker.ts wires it, with the real handler and the real HTTP client.
    handler = new AiExtractionHandler(
      tenantDb,
      new LocalFsStorage(root),
      new HttpAiExtractor(config(redisUrl) as unknown as ConfigService<Env, true>),
    );
    worker = new ExtractionWorker(
      config(redisUrl) as unknown as ConfigService<Env, true>,
      new ExtractionProcessor(tenantDb, live.get(DocumentStateMachine, { strict: false }), handler),
    );
    worker.onApplicationBootstrap();
  });
  afterAll(async () => {
    await reset();
    await worker?.onApplicationShutdown();
    await live?.close();
    await new Promise<void>((r) => ai.close(() => r()));
    await Promise.all([owner.end(), pool.end()]);
    await redis.stop().catch(() => undefined);
  });
  beforeEach(reset);

  it('upload XML -> needs_review -> GET shows the extracted invoice (and the AI got the same bytes + token)', async () => {
    const up = await uploadXml('k1').expect(201);
    const id: string = up.body.id;

    // Right after upload there is nothing to show yet.
    const early = await get(id).expect(200);
    expect(early.body.extraction === null || early.body.status === 'needs_review').toBe(true);

    await waitForStatus(id, 'needs_review');
    const res = await get(id).expect(200);
    expect(res.body).toMatchObject({
      id,
      status: 'needs_review',
      sourceType: 'xml',
      failureCode: null,
      extraction: { source: 'xml', documentVersion: 1 },
    });
    expect(res.body.extraction.data.invoiceNo).toBe(INVOICE.invoiceNo);
    expect(res.body.extraction.data.total).toBe(INVOICE.total);
    expect(res.body.extraction.data.fieldMeta).toBeDefined();

    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]?.authorization).toBe(`Bearer ${AI_TOKEN}`);
    expect(aiCalls[0]?.sourceType).toBe('xml');
    expect(aiCalls[0]?.body.includes(XML)).toBe(true); // the stored file, byte for byte

    const row = (await owner.query('SELECT * FROM extractions WHERE document_id = $1', [id]))
      .rows[0];
    expect(row).toMatchObject({ source: 'xml', model: null, cost_usd: null, tenant_id: ACME });
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('is idempotent: the same job delivered again adds no row and does not call the AI again', async () => {
    const up = await uploadXml('k1').expect(201);
    await waitForStatus(up.body.id, 'needs_review');
    expect(aiCalls).toHaveLength(1);

    await handler.extract({ documentId: up.body.id, tenantId: ACME });
    expect(aiCalls).toHaveLength(1);
    expect(await extractionCount(up.body.id)).toBe(1);
  });

  it('two deliveries running at the same moment still leave one row (the unique key decides, not luck)', async () => {
    const up = await uploadXml('k1').expect(201);
    await waitForStatus(up.body.id, 'needs_review');
    await owner.query('DELETE FROM extractions WHERE document_id = $1', [up.body.id]);
    aiCalls = [];

    const job = { documentId: up.body.id as string, tenantId: ACME };
    await Promise.all([handler.extract(job), handler.extract(job)]);
    expect(aiCalls).toHaveLength(2); // both passed the "already extracted?" check, as in a real race
    expect(await extractionCount(up.body.id)).toBe(1);
  });

  it('AI service down: 5 attempts, then failed with a code that GET returns (no extraction stored)', async () => {
    mode = 'down';
    const up = await uploadXml('k1').expect(201);
    await waitForStatus(up.body.id, 'failed');
    expect(aiCalls).toHaveLength(5);
    expect(await extractionCount(up.body.id)).toBe(0);

    const res = await get(up.body.id).expect(200);
    expect(res.body).toMatchObject({
      status: 'failed',
      failureCode: 'EXTRACTION_RETRIES_EXHAUSTED',
      extraction: null,
    });

    // Service back + admin retry: succeeds and the stale failure code is gone.
    mode = 'ok';
    await request(live.getHttpServer())
      .post(`/admin/jobs/${up.body.id}/retry`)
      .set('Authorization', 'Bearer tenant_admin@acme')
      .expect(202);
    await waitForStatus(up.body.id, 'needs_review');
    const after = await get(up.body.id).expect(200);
    expect(after.body.failureCode).toBeNull();
    expect(after.body.extraction.data.invoiceNo).toBe(INVOICE.invoiceNo);
  });

  it('a wrong token is retried, then fails as AI_SERVICE_MISCONFIGURED (not as a file error) and can be retried once fixed', async () => {
    mode = 'unauthorized';
    const up = await uploadXml('k1').expect(201);
    await waitForStatus(up.body.id, 'failed');
    expect(aiCalls).toHaveLength(5);
    expect((await get(up.body.id).expect(200)).body.failureCode).toBe('AI_SERVICE_MISCONFIGURED');

    mode = 'ok'; // the operator fixed the token
    await request(live.getHttpServer())
      .post(`/admin/jobs/${up.body.id}/retry`)
      .set('Authorization', 'Bearer tenant_admin@acme')
      .expect(202);
    await waitForStatus(up.body.id, 'needs_review');
  });

  it('a 5xx from the AI service is retried like an outage', async () => {
    mode = 'unavailable';
    const up = await uploadXml('k1').expect(201);
    await waitForStatus(up.body.id, 'failed');
    expect(aiCalls).toHaveLength(5);
  });

  it('a permanent AI answer (422 XML_MALFORMED) fails the document at once with that code', async () => {
    mode = 'malformed';
    const up = await uploadXml('k1').expect(201);
    await waitForStatus(up.body.id, 'failed');
    expect(aiCalls).toHaveLength(1);
    expect((await get(up.body.id).expect(200)).body.failureCode).toBe('XML_MALFORMED');
  });

  const uploadPdf = (key: string) =>
    upload(
      Buffer.from(`%PDF-1.7\nSAMPLE ${key} ${Math.random()}\n`),
      'a.pdf',
      'application/pdf',
      key,
    );
  const row = async (id: string) =>
    (
      await owner.query(
        `SELECT source, model, prompt_version, input_tokens, output_tokens, latency_ms, cost_usd
           FROM extractions WHERE document_id = $1`,
        [id],
      )
    ).rows[0] as Record<string, unknown>;

  it('T3.2: a PDF reaches the AI as sourceType=pdf, becomes needs_review with data, and keeps model, prompt version, tokens, cost and latency', async () => {
    mode = 'llm-ok';
    const up = await uploadPdf('k1').expect(201);
    await waitForStatus(up.body.id, 'needs_review');
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]?.sourceType).toBe('pdf');

    expect(await row(up.body.id)).toMatchObject({
      source: 'pdf',
      model: USAGE.model,
      prompt_version: USAGE.promptVersion,
      input_tokens: USAGE.inputTokens,
      output_tokens: USAGE.outputTokens,
      latency_ms: USAGE.latencyMs,
      cost_usd: '0.001634',
    });
    const res = await get(up.body.id).expect(200);
    expect(res.body.extraction.data.invoiceNo).toBe(INVOICE.invoiceNo);
  });

  it('T3.3: rule warnings are stored on the fields, the numbers stay as the AI returned them, and GET shows them', async () => {
    mode = 'llm-inconsistent';
    const up = await uploadPdf('k1').expect(201);
    await waitForStatus(up.body.id, 'needs_review');
    const res = await get(up.body.id).expect(200);
    const warnings = res.body.extraction.warnings as { code: string; path: string }[];
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ['TOTAL_MISMATCH', 'total'],
      ['ISSUE_DATE_FUTURE', 'issueDate'],
    ]);
    expect(res.body.extraction.data.total).toBe(0); // flagged, never corrected
  });

  it('T3.2: the provider fails with 500 twice, then answers: the document succeeds after the retries, one row, three calls', async () => {
    mode = 'llm-flaky';
    const up = await uploadPdf('k1').expect(201);
    await waitForStatus(up.body.id, 'needs_review');
    expect(aiCalls).toHaveLength(3);
    expect(await extractionCount(up.body.id)).toBe(1);
    expect((await get(up.body.id).expect(200)).body.failureCode).toBeNull();
  });

  it.each([
    ['llm-unavailable', 'LLM_UNAVAILABLE'],
    ['llm-rate-limited', 'LLM_RATE_LIMITED'],
  ] as const)(
    "T3.2: %s is transient: 5 attempts, then failed with the AI service's own code %s",
    async (m, code) => {
      mode = m;
      const up = await uploadPdf('k1').expect(201);
      await waitForStatus(up.body.id, 'failed');
      expect(aiCalls).toHaveLength(5);
      expect(await extractionCount(up.body.id)).toBe(0);
      expect((await get(up.body.id).expect(200)).body.failureCode).toBe(code);
    },
  );

  it('T3.2: a permanent LLM-path answer (422 PDF_INVALID) fails at once with that code, no retry', async () => {
    mode = 'llm-rejected';
    const up = await uploadPdf('k1').expect(201);
    await waitForStatus(up.body.id, 'failed');
    expect(aiCalls).toHaveLength(1);
    expect((await get(up.body.id).expect(200)).body.failureCode).toBe('PDF_INVALID');
  });

  it('T3.2: a PDF on a service that has no LLM path yet (501) is still a permanent failure', async () => {
    mode = 'not-implemented';
    const up = await uploadPdf('k1').expect(201);
    await waitForStatus(up.body.id, 'failed');
    expect(aiCalls).toHaveLength(1);
    expect((await get(up.body.id).expect(200)).body.failureCode).toBe(
      'EXTRACTION_PATH_NOT_IMPLEMENTED',
    );
  });

  it('an answer that is not a valid invoice fails with EXTRACTION_SCHEMA_INVALID and stores nothing', async () => {
    mode = 'garbage';
    const up = await uploadXml('k1').expect(201);
    await waitForStatus(up.body.id, 'failed');
    expect(aiCalls).toHaveLength(1);
    expect(await extractionCount(up.body.id)).toBe(0);
    expect((await get(up.body.id).expect(200)).body.failureCode).toBe('EXTRACTION_SCHEMA_INVALID');
  });

  it('another tenant gets 404 (RLS), a malformed id 404, no token 401, a viewer may read', async () => {
    const up = await uploadXml('k1').expect(201);
    await waitForStatus(up.body.id, 'needs_review');
    await get(up.body.id, 'tenant_admin@globex').expect(404);
    await get('not-a-uuid').expect(404);
    await get('00000000-0000-4000-8000-00000000dead').expect(404);
    await request(live.getHttpServer()).get(`/documents/${up.body.id}`).expect(401);
    await get(up.body.id, 'viewer@acme').expect(200);
  });

  it('T3.3: stored warnings that do not match the rule format are left out, the page still loads', async () => {
    mode = 'llm-inconsistent';
    const up = await uploadPdf('k1').expect(201);
    await waitForStatus(up.body.id, 'needs_review');
    await owner.query(
      `UPDATE extractions SET warnings = '["old free text", {"code":"TOTAL_MISMATCH","path":"total","params":{"expected":1,"actual":0}}]'::jsonb WHERE document_id = $1`,
      [up.body.id],
    );
    const res = await get(up.body.id).expect(200);
    expect(res.body.extraction.warnings).toEqual([
      { code: 'TOTAL_MISMATCH', path: 'total', params: { expected: 1, actual: 0 } },
    ]);
  });

  it('an extraction row that no longer matches InvoiceSchema is a loud 500, not silently shown', async () => {
    const up = await uploadXml('k1').expect(201);
    await waitForStatus(up.body.id, 'needs_review');
    await owner.query(`UPDATE extractions SET data = '{"total": 1}' WHERE document_id = $1`, [
      up.body.id,
    ]);
    const res = await get(up.body.id).expect(500);
    expect(res.body.code).toBe('EXTRACTION_DATA_INVALID');
    expect(JSON.stringify(res.body)).not.toContain('"total"');
  });

  it('the app role can read and insert extractions but never change or delete them', async () => {
    const up = await uploadXml('k1').expect(201);
    await waitForStatus(up.body.id, 'needs_review');
    for (const statement of [`UPDATE extractions SET latency_ms = 1`, `DELETE FROM extractions`]) {
      // Drizzle wraps the pg error ("Failed query"); the real message is on `cause`.
      const err = (await tenantDb
        .run(ACME, (tx) => tx.execute(sql.raw(statement)))
        .catch((e: Error) => e)) as Error & { cause?: Error };
      expect(err.cause?.message).toMatch(/permission denied/);
    }
    expect(await extractionCount(up.body.id)).toBe(1);
  });
});
