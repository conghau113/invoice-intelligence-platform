/**
 * T6.3 with real Postgres (app role, RLS) and real Redis in containers: cache-aside of GET /documents
 * and GET /insights/extraction (tenant in every key, generation bumped after COMMIT), and the
 * extraction result cache of the worker (same bytes + model + prompt + pipeline -> no second LLM
 * call, coalescing of two attempts at once). Only the AI service (a local HTTP stand-in) and the
 * token check are replaced. The last block measures before/after (latency, LLM calls) for the
 * learning log; its assertions cover the call counts only, the timings are printed.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { InvoiceSchema, type Invoice } from 'contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import request from 'supertest';
import type { StartedTestContainer } from 'testcontainers';
import type { Env } from '../src/config/env.schema';
import * as schema from '../src/db/schema';
import { seedDocuments } from '../src/db/seed-documents';
import { DB, TenantDbService, type Tx } from '../src/db/tenant-db.service';
import { TenantTransactionInterceptor } from '../src/db/tenant-transaction.interceptor';
import { ExtractionResultCache } from '../src/modules/cache/application/extraction-result-cache';
import { STATS_KEY, generationKey } from '../src/modules/cache/domain/cache-keys';
import { RedisCacheStore } from '../src/modules/cache/infra/redis-cache-store';
import { DocumentStateMachine } from '../src/modules/documents/application/document-state-machine';
import { DocumentsListService } from '../src/modules/documents/application/documents-list.service';
import { parseDocumentListQuery } from '../src/modules/documents/domain/document-list-query';
import { DocumentsModule } from '../src/modules/documents/documents.module';
import { AiExtractionHandler } from '../src/modules/extraction/application/ai-extraction.handler';
import { HttpAiExtractor } from '../src/modules/extraction/infra/http-ai-extractor';
import { InsightsService } from '../src/modules/insights/application/insights.service';
import { InsightsModule } from '../src/modules/insights/insights.module';
import { EXTRACTION_QUEUE_PORT } from '../src/modules/queue/application/extraction-queue.port';
import { producerConnection } from '../src/modules/queue/infra/redis-connection';
import { FakeExtractionQueue } from '../src/modules/queue/testing/fake-extraction-queue';
import { ReviewModule } from '../src/modules/review/review.module';
import { INDEX_QUEUE_PORT } from '../src/modules/search/application/index-queue.port';
import { FakeIndexQueue } from '../src/modules/search/testing/fake-index-queue';
import { STORAGE_PORT } from '../src/modules/storage/application/storage.port';
import { LocalFsStorage } from '../src/modules/storage/infra/local-fs.storage';
import { useTestRoots } from '../src/modules/storage/testing/test-root';
import { startRedis } from './support/reachable-container';
import { deleteDocumentsOf, stubAuthProviders } from './support/test-app';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const USER = '00000000-0000-4000-8000-00000000f063';
const AI_TOKEN = 'integration-token-0123456789';
const MEASURE_PREFIX = 'measure-t63';
const newRoot = useTestRoots();

const INVOICE: Invoice = InvoiceSchema.parse(
  JSON.parse(
    readFileSync(
      path.join(__dirname, '../../../packages/contracts/fixtures/invoice.valid.json'),
      'utf8',
    ),
  ),
);
const XML = readFileSync(
  path.join(__dirname, '../../ai/tests/fixtures/xml_invoices/invoice-00.xml'),
);
const USAGE = {
  model: 'gemini-test',
  promptVersion: 'invoice_extraction/v1',
  inputTokens: 1500,
  outputTokens: 800,
  latencyMs: 3200,
  costUsd: 0.001634,
};

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;

// Measurement helpers (pure, so they live outside the suite).
const fmt = (n: number) => n.toFixed(2);
const summary = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b);
  return `p50 ${fmt(quantile(sorted, 0.5))} ms, p95 ${fmt(quantile(sorted, 0.95))} ms`;
};
const hitRate = (s: Record<string, number>, name: string) => {
  const hit = s[`${name}:hit`] ?? 0;
  const all = hit + (s[`${name}:miss`] ?? 0) + (s[`${name}:coalesced`] ?? 0);
  return all === 0 ? 0 : hit / all;
};
async function time(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

describe('cache (T6.3): cache-aside reads and the extraction result cache', () => {
  let owner: Pool;
  let pool: Pool;
  let redis: StartedTestContainer;
  let redisUrl: string;
  let client: Redis;
  let root: string;
  let storage: LocalFsStorage;
  let ai: Server;
  let app: INestApplication;
  const extra: INestApplication[] = [];
  const connections: Redis[] = [];

  // The stand-in AI service: what it answers and what it saw.
  let extractCalls = 0;
  let extractDelayMs = 0;
  let versionDown = false;
  let pipelineVersion = 'p'.repeat(64);

  const env = (url: string, cacheEnabled: boolean) =>
    ({
      REDIS_URL: url,
      CACHE_ENABLED: cacheEnabled,
      AI_LLM_TIMEOUT_MS: 2_000,
      AI_SERVICE_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
      AI_SERVICE_TOKEN: AI_TOKEN,
    }) satisfies Partial<Env>;
  const configOf = (values: Record<string, unknown>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService<Env, true>;

  async function makeApp(cacheEnabled: boolean, url = redisUrl): Promise<INestApplication> {
    const values = env(url, cacheEnabled);
    @Global()
    @Module({
      providers: [
        { provide: DB, useValue: drizzle(pool, { schema }) },
        TenantDbService,
        { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
        { provide: ConfigService, useValue: configOf(values) },
      ],
      exports: [DB, TenantDbService, ConfigService],
    })
    class RealDbModule {}
    const mod = await Test.createTestingModule({
      imports: [RealDbModule, DocumentsModule, ReviewModule, InsightsModule],
      providers: stubAuthProviders(USER, { acme: ACME, globex: GLOBEX }),
    })
      .overrideProvider(STORAGE_PORT)
      .useValue(storage)
      .overrideProvider(EXTRACTION_QUEUE_PORT)
      .useValue(new FakeExtractionQueue())
      .overrideProvider(INDEX_QUEUE_PORT)
      .useValue(new FakeIndexQueue())
      .compile();
    const made = mod.createNestApplication();
    await made.init();
    return made;
  }

  const list = (on: INestApplication, qs = '', token = 'viewer@acme') =>
    request(on.getHttpServer()).get(`/documents${qs}`).set('Authorization', `Bearer ${token}`);
  const insights = (on: INestApplication, token = 'viewer@acme') =>
    request(on.getHttpServer()).get('/insights/extraction').set('Authorization', `Bearer ${token}`);
  const stats = async (): Promise<Record<string, number>> =>
    Object.fromEntries(
      Object.entries(await client.hgetall(STATS_KEY)).map(([k, v]) => [k, Number(v)]),
    );
  const generation = async (tenant: string) =>
    Number((await client.get(generationKey(tenant))) ?? 0);

  /** A document in `status`, inserted by the owner (no cache knows about it until the next bump). */
  async function insertDoc(
    tenant: string,
    status = 'needs_review',
    source: 'pdf' | 'xml' = 'pdf',
  ): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO documents (id, tenant_id, status, source_type, storage_key, content_hash, version, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7)`,
      [id, tenant, status, source, `tenant/${tenant}/${id}`, randomBytes(32).toString('hex'), USER],
    );
    return id;
  }
  /** A PDF document whose file is really stored, so the worker can read it; returns the job. */
  async function storedPdf(tenant: string, bytes: Buffer) {
    const id = randomUUID();
    const key = `tenant/${tenant}/${id}`;
    const stored = await storage.put(key, Readable.from(bytes));
    await owner.query(
      `INSERT INTO documents (id, tenant_id, status, source_type, storage_key, content_hash, version, uploaded_by)
       VALUES ($1, $2, 'processing', 'pdf', $3, $4, 1, $5)`,
      [id, tenant, key, stored.sha256, USER],
    );
    return { documentId: id, tenantId: tenant, contentHash: stored.sha256 };
  }
  const extractionRows = async (documentId: string) =>
    (
      await owner.query<{
        model: string | null;
        input_tokens: number | null;
        cost_usd: string | null;
      }>('SELECT model, input_tokens, cost_usd FROM extractions WHERE document_id = $1', [
        documentId,
      ])
    ).rows;
  const forgetExtraction = (documentId: string) =>
    owner.query('DELETE FROM extractions WHERE document_id = $1', [documentId]);

  /** A TenantDbService whose `failAt`-th run rejects once, like a connection lost after the AI call. */
  class FlakyTenantDb extends TenantDbService {
    private runs = 0;
    constructor(private readonly failAt: number | null) {
      super(drizzle(pool, { schema }));
    }
    override run<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
      this.runs += 1;
      if (this.runs === this.failAt) return Promise.reject(new Error('connection reset'));
      return super.run(tenantId, fn);
    }
  }

  /**
   * The worker side, wired like src/worker.ts. One Redis connection for all of them, opened once like
   * the process does: a connection that is not `ready` yet refuses commands (no offline queue), and
   * the cache would then fall back to calling the AI.
   */
  let workerRedis: Redis;
  function worker({ cacheEnabled = true, failAt = null as number | null } = {}) {
    const results = new ExtractionResultCache(new RedisCacheStore(workerRedis), cacheEnabled, {
      resultTtlMs: 60_000,
      lockTtlMs: 3_000,
      pollMs: 20,
    });
    const config = configOf(env(redisUrl, cacheEnabled));
    return new AiExtractionHandler(
      new FlakyTenantDb(failAt),
      storage,
      new HttpAiExtractor(config),
      results,
    );
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 2 });
    pool = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 8 });
    root = await newRoot();
    storage = new LocalFsStorage(root);

    ai = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const json = (status: number, body: unknown) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        if (req.headers.authorization !== `Bearer ${AI_TOKEN}`) return json(401, {});
        if (req.method === 'GET' && req.url === '/extract/version') {
          if (versionDown) return json(503, { code: 'LLM_UNAVAILABLE' });
          return json(200, {
            model: USAGE.model,
            promptVersion: USAGE.promptVersion,
            pipelineVersion,
          });
        }
        if (req.method === 'POST' && req.url === '/extract') {
          extractCalls += 1;
          setTimeout(
            () => json(200, { invoice: INVOICE, warnings: [], usage: USAGE }),
            extractDelayMs,
          );
          return;
        }
        json(404, {});
      });
    });
    await new Promise<void>((r) => ai.listen(0, '127.0.0.1', r));

    redis = await startRedis();
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    client = new Redis(redisUrl);
    workerRedis = producerConnection(redisUrl);
    connections.push(workerRedis);
    await new Promise<void>((resolve) => workerRedis.once('ready', () => resolve()));
    app = await makeApp(true);
  });
  beforeEach(async () => {
    await client.flushall();
    extractCalls = 0;
    extractDelayMs = 0;
    versionDown = false;
    pipelineVersion = 'p'.repeat(64);
  });
  const clean = async () => {
    await owner.query('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1)', [[ACME, GLOBEX]]);
    await deleteDocumentsOf(owner, USER);
  };
  afterEach(clean);
  afterAll(async () => {
    await owner.query(
      `DELETE FROM notifications WHERE document_id IN
         (SELECT id FROM documents WHERE storage_key LIKE '%/sample-${MEASURE_PREFIX}-%')`,
    );
    await owner.query(
      `DELETE FROM documents WHERE storage_key LIKE '%/sample-${MEASURE_PREFIX}-%'`,
    );
    for (const made of extra) await made.close();
    await app?.close();
    for (const c of connections) c.disconnect();
    client?.disconnect();
    await new Promise<void>((r) => ai.close(() => r()));
    await Promise.all([owner.end(), pool.end()]);
    await redis.stop().catch(() => undefined);
  });

  describe('GET /documents (cache-aside, ADR 0013)', () => {
    it('a repeated page comes from Redis; a status change shows on the very next read', async () => {
      const id = await insertDoc(ACME);
      const first = await list(app).expect(200);
      expect(first.body.items).toEqual([expect.objectContaining({ id, status: 'needs_review' })]);
      const before = await stats();
      const again = await list(app).expect(200);
      expect(again.body).toEqual(first.body);
      expect((await stats())['documents-list:hit']).toBe((before['documents-list:hit'] ?? 0) + 1);

      const tenantDb = app.get(TenantDbService);
      const machine = app.get(DocumentStateMachine, { strict: false });
      await tenantDb.run(ACME, () => machine.transition(id, 'approved', { actorId: USER }));
      const after = await list(app).expect(200);
      expect(after.body.items).toEqual([expect.objectContaining({ id, status: 'approved' })]);
    });

    it('a change that rolls back does not bump the generation', async () => {
      const id = await insertDoc(ACME);
      await list(app).expect(200);
      const gen = await generation(ACME);
      const tenantDb = app.get(TenantDbService);
      const machine = app.get(DocumentStateMachine, { strict: false });
      await expect(
        tenantDb.run(ACME, async () => {
          await machine.transition(id, 'approved', { actorId: USER });
          throw new Error('later step failed');
        }),
      ).rejects.toThrow('later step failed');
      expect(await generation(ACME)).toBe(gen);
      const page = await list(app).expect(200);
      expect(page.body.items).toEqual([expect.objectContaining({ id, status: 'needs_review' })]);
    });

    it('an upload is visible on the next read (register and queue both bump)', async () => {
      await insertDoc(ACME);
      const before = await list(app).expect(200);
      expect(before.body.meta.total).toBe(1);
      await request(app.getHttpServer())
        .post('/documents/upload')
        .set('Authorization', 'Bearer accountant@acme')
        .set('Idempotency-Key', randomUUID())
        .attach('file', XML, { filename: 'a.xml', contentType: 'application/xml' })
        .expect(201);
      const after = await list(app).expect(200);
      expect(after.body.meta.total).toBe(2);
      expect(after.body.items[0]).toEqual(expect.objectContaining({ status: 'queued' }));
    });

    it("tenants never see each other's cached page, and one tenant's write leaves the other cached", async () => {
      const mine = await insertDoc(ACME);
      const theirs = await insertDoc(GLOBEX);
      const a = await list(app, '', 'viewer@acme').expect(200);
      const g = await list(app, '', 'viewer@globex').expect(200);
      expect(a.body.items.map((i: { id: string }) => i.id)).toEqual([mine]);
      expect(g.body.items.map((i: { id: string }) => i.id)).toEqual([theirs]);

      const acmeGen = await generation(ACME);
      const tenantDb = app.get(TenantDbService);
      const machine = app.get(DocumentStateMachine, { strict: false });
      await tenantDb.run(GLOBEX, () => machine.transition(theirs, 'approved', { actorId: USER }));
      expect(await generation(ACME)).toBe(acmeGen);
      expect(await generation(GLOBEX)).toBeGreaterThan(0);
      const before = await stats();
      await list(app, '', 'viewer@acme').expect(200);
      expect((await stats())['documents-list:hit']).toBe((before['documents-list:hit'] ?? 0) + 1);
    });

    it('every key carries the tenant and a TTL of at most 30 s', async () => {
      await insertDoc(ACME);
      await list(app, '?page=1&limit=20').expect(200);
      const keys = await client.keys('cache:*');
      const listKeys = keys.filter((k) => k.includes('documents-list'));
      expect(listKeys).toHaveLength(1);
      expect(listKeys[0]).toMatch(new RegExp(String.raw`^cache:\{${ACME}\}:g0:documents-list:`));
      const ttl = await client.pttl(listKeys[0]!);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30_000);
    });

    it('Redis down: the list and the dashboard still answer from Postgres', async () => {
      const id = await insertDoc(ACME);
      const down = await makeApp(true, 'redis://127.0.0.1:1');
      extra.push(down);
      const page = await list(down).expect(200);
      expect(page.body.items).toEqual([expect.objectContaining({ id })]);
      await insights(down).expect(200);
    });
  });

  describe('GET /insights/extraction (cache-aside)', () => {
    it('is served from Redis until an approval or a reopen, which shows on the next read', async () => {
      const id = await insertDoc(ACME, 'needs_review', 'pdf');
      await owner.query(
        `INSERT INTO extractions (tenant_id, document_id, document_version, source, data, latency_ms)
         VALUES ($1, $2, 1, 'pdf', $3, 10)`,
        [ACME, id, JSON.stringify(INVOICE)],
      );
      const first = await insights(app).expect(200);
      const before = await stats();
      await insights(app).expect(200);
      expect((await stats())['insights-online:hit']).toBe((before['insights-online:hit'] ?? 0) + 1);

      await request(app.getHttpServer())
        .post(`/documents/${id}/approve`)
        .set('Authorization', 'Bearer accountant@acme')
        .set('If-Match', '"1"')
        .send(INVOICE)
        .expect(200);
      const after = await insights(app).expect(200);
      expect(after.body.online.approvedDocuments).toBe(first.body.online.approvedDocuments + 1);

      // Reopening takes it out of the approved population again, on the very next read.
      await insights(app).expect(200); // cached again
      await request(app.getHttpServer())
        .post(`/documents/${id}/reopen`)
        .set('Authorization', 'Bearer accountant@acme')
        .set('If-Match', '"1"')
        .send()
        .expect(200);
      const reopened = await insights(app).expect(200);
      expect(reopened.body.online.approvedDocuments).toBe(first.body.online.approvedDocuments);
    });
  });

  describe('extraction result cache (worker)', () => {
    const pdf = () => Buffer.from(`%PDF-1.7 SAMPLE ${randomUUID()}`);

    it('the attempt after a failed database write reuses the answer: one LLM call, its cost recorded once', async () => {
      const job = await storedPdf(ACME, pdf());
      // Run 1 reads the document, run 2 would store the answer: it fails like a dropped connection.
      await expect(worker({ failAt: 2 }).extract(job)).rejects.toThrow('connection reset');
      expect(extractCalls).toBe(1);
      await worker().extract(job);
      expect(extractCalls).toBe(1);
      // The answer reused keeps the cost of the call that produced it: that call's row was never
      // written, so recording $0 would hide what was paid (code review T6.3).
      expect(await extractionRows(job.documentId)).toEqual([
        {
          model: USAGE.model,
          input_tokens: USAGE.inputTokens,
          cost_usd: USAGE.costUsd.toFixed(6),
        },
      ]);
    });

    it('two deliveries of the same job at once call the AI once (coalescing)', async () => {
      extractDelayMs = 300;
      const job = await storedPdf(ACME, pdf());
      await Promise.all([worker().extract(job), worker().extract(job)]);
      expect(extractCalls).toBe(1);
      expect(await extractionRows(job.documentId)).toHaveLength(1);
    });

    it('a new pipeline version is a miss; the same version again is a hit', async () => {
      const job = await storedPdf(ACME, pdf());
      await worker().extract(job);
      await forgetExtraction(job.documentId);
      pipelineVersion = 'q'.repeat(64); // e.g. image_normalize.py changed (Phát sinh T4.1b)
      await worker().extract(job);
      expect(extractCalls).toBe(2);
      await forgetExtraction(job.documentId);
      await worker().extract(job);
      expect(extractCalls).toBe(2);
    });

    it('the same bytes in another tenant call the AI again (tenant in the key)', async () => {
      const bytes = pdf();
      await worker().extract(await storedPdf(ACME, bytes));
      const other = await storedPdf(GLOBEX, bytes);
      await worker().extract(other);
      expect(extractCalls).toBe(2);
      expect((await extractionRows(other.documentId))[0]?.cost_usd).toBe(USAGE.costUsd.toFixed(6));
    });

    it('no version from the AI service: no cache, the AI is called every time', async () => {
      versionDown = true;
      const job = await storedPdf(ACME, pdf());
      await worker().extract(job);
      await forgetExtraction(job.documentId);
      await worker().extract(job);
      expect(extractCalls).toBe(2);
    });

    it('the result is stored under the tenant key with a bounded TTL; the lock is gone', async () => {
      const job = await storedPdf(ACME, pdf());
      await worker().extract(job);
      const keys = await client.keys(`cache:{${ACME}}:extract:*`);
      expect(keys).toEqual([
        `cache:{${ACME}}:extract:${job.contentHash}:${USAGE.model}:${USAGE.promptVersion}:${pipelineVersion}`,
      ]);
      const ttl = await client.pttl(keys[0]!);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });
  });

  describe('measurement for the learning log (Xong khi)', () => {
    const REQUESTS = 300;
    // 4 x 300 timed HTTP reads, 4 x 300 service reads and a 1,000-row seed: over the default 30 s.
    jest.setTimeout(300_000);
    const report: string[] = [];
    afterAll(() => {
      // Printed on purpose: these are the numbers the learning log quotes.
      console.log(`T6.3 measurement\n${report.join('\n')}`);
    });

    const get = (on: INestApplication, url: string) =>
      request(on.getHttpServer()).get(url).set('Authorization', 'Bearer viewer@acme').expect(200);

    it('list and dashboard latency, cache off vs on, at 1,000 documents', async () => {
      await seedDocuments(owner, ACME, 1000, MEASURE_PREFIX);
      const off = await makeApp(false);
      extra.push(off);
      const pages = (i: number) => `/documents?page=${1 + (i % 5)}&limit=20`;
      // Off and on take turns request by request, so a busy moment of the machine hits both alike.
      const http = {
        listOff: [] as number[],
        listOn: [] as number[],
        dashOff: [] as number[],
        dashOn: [] as number[],
      };
      for (let i = 0; i < 10; i++) {
        await get(off, pages(i));
        await get(app, pages(i));
        await get(off, '/insights/extraction');
        await get(app, '/insights/extraction');
      }
      await client.del(STATS_KEY);
      for (let i = 0; i < REQUESTS; i++) {
        http.listOff.push(await time(() => get(off, pages(i))));
        http.listOn.push(await time(() => get(app, pages(i))));
        http.dashOff.push(await time(() => get(off, '/insights/extraction')));
        http.dashOn.push(await time(() => get(app, '/insights/extraction')));
      }
      const s = await stats();
      report.push(
        `HTTP, ${REQUESTS} reads each, 5 pages of 20 out of 1,000 rows, off/on interleaved:`,
        `  GET /documents           off ${summary(http.listOff)} | on ${summary(http.listOn)} (hit ${fmt(hitRate(s, 'documents-list') * 100)}%)`,
        `  GET /insights/extraction off ${summary(http.dashOff)} | on ${summary(http.dashOn)} (hit ${fmt(hitRate(s, 'insights-online') * 100)}%)`,
      );
      expect(hitRate(s, 'documents-list')).toBeGreaterThan(0.9);

      // The same read without HTTP, guards and Nest: inside one tenant transaction (which a hit
      // still opens), the database queries against one Redis GET.
      const tenantDb = app.get(TenantDbService);
      const listsOn = app.get(DocumentsListService, { strict: false });
      const insightsOn = app.get(InsightsService, { strict: false });
      const insightsOff = off.get(InsightsService, { strict: false });
      // Each app has its own TenantDbService (and transaction scope): run off's service in off's.
      const tenantDbOff = off.get(TenantDbService);
      const query = parseDocumentListQuery({ page: '3', limit: '20' });
      const service = {
        listDb: [] as number[],
        listHit: [] as number[],
        dashDb: [] as number[],
        dashHit: [] as number[],
      };
      for (let i = 0; i < REQUESTS; i++) {
        service.listDb.push(await time(() => tenantDb.run(ACME, () => listsOn.load(ACME, query))));
        service.listHit.push(await time(() => tenantDb.run(ACME, () => listsOn.list(ACME, query))));
        service.dashDb.push(
          await time(() => tenantDbOff.run(ACME, () => insightsOff.extraction(ACME))),
        );
        service.dashHit.push(
          await time(() => tenantDb.run(ACME, () => insightsOn.extraction(ACME))),
        );
      }
      report.push(
        `Service, inside a tenant transaction, ${REQUESTS} each:`,
        `  documents list  Postgres ${summary(service.listDb)} | Redis hit ${summary(service.listHit)}`,
        `  insights online Postgres ${summary(service.dashDb)} | Redis hit ${summary(service.dashHit)}`,
      );

      // With writes: one status change every 10 reads (documents moving through the pipeline).
      await client.del(STATS_KEY);
      const moving = await insertDoc(ACME, 'needs_review');
      const machine = app.get(DocumentStateMachine, { strict: false });
      let approved = false;
      const mixed: number[] = [];
      for (let i = 0; i < REQUESTS; i++) {
        if (i % 10 === 9) {
          approved = !approved;
          await tenantDb.run(ACME, () =>
            machine.transition(moving, approved ? 'approved' : 'needs_review', { actorId: USER }),
          );
        }
        mixed.push(await time(() => get(app, '/documents?page=1&limit=20')));
      }
      report.push(
        `HTTP, cache on, 1 status change per 10 reads: GET /documents ${summary(mixed)} (hit ${fmt(hitRate(await stats(), 'documents-list') * 100)}%)`,
      );
    });

    it('LLM calls for 20 PDFs, cache off vs on', async () => {
      const DOCS = 20;
      for (const cacheEnabled of [false, true]) {
        // Two deliveries of every job at once (stalled job redelivered, Phát sinh T2.9).
        extractCalls = 0;
        extractDelayMs = 100;
        const jobs = await Promise.all(
          Array.from({ length: DOCS }, () =>
            storedPdf(ACME, Buffer.from(`%PDF SAMPLE ${randomUUID()}`)),
          ),
        );
        await Promise.all(
          jobs.flatMap((job) => [
            worker({ cacheEnabled }).extract(job),
            worker({ cacheEnabled }).extract(job),
          ]),
        );
        const duplicate = extractCalls;

        // The database write after the answer fails once, then the job's retry.
        extractCalls = 0;
        extractDelayMs = 0;
        for (let i = 0; i < DOCS; i++) {
          const job = await storedPdf(ACME, Buffer.from(`%PDF SAMPLE ${randomUUID()}`));
          await expect(worker({ cacheEnabled, failAt: 2 }).extract(job)).rejects.toThrow();
          await worker({ cacheEnabled }).extract(job);
        }
        const retried = extractCalls;
        report.push(
          `cache ${cacheEnabled ? 'on' : 'off'}: ${DOCS} PDFs delivered twice at once -> ${duplicate} LLM calls; ${DOCS} PDFs whose write failed once -> ${retried} LLM calls`,
        );
        expect(duplicate).toBe(cacheEnabled ? DOCS : 2 * DOCS);
        expect(retried).toBe(cacheEnabled ? DOCS : 2 * DOCS);
        await clean();
      }
    });
  });
});
