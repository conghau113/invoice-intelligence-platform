/**
 * Upload -> queue -> worker -> document status, with real Postgres (app role, RLS) and a real Redis,
 * both in containers. Only the extraction handler is scripted and token verification is stubbed.
 * Covers the T2.4 checks: a worker that fails twice then succeeds, jobs that run out of attempts,
 * one job per document, tenant isolation of the admin endpoints, and Redis being down.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { Queue } from 'bullmq';
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
import type { ExtractionHandler } from '../src/modules/queue/application/extraction-handler.port';
import { ExtractionProcessor } from '../src/modules/queue/application/extraction.processor';
import { PermanentExtractionError } from '../src/modules/queue/domain/extraction-job';
import { ExtractionWorker } from '../src/modules/queue/infra/extraction-worker';
import { QueueAdminModule } from '../src/modules/queue/queue-admin.module';
import { EXTRACTION_QUEUE_PORT } from '../src/modules/queue/application/extraction-queue.port';
import { STORAGE_PORT } from '../src/modules/storage/application/storage.port';
import { LocalFsStorage } from '../src/modules/storage/infra/local-fs.storage';
import { useTestRoots } from '../src/modules/storage/testing/test-root';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
// A tenant with no rows: jobs for it fail at once and show only in its own admin list.
const NOBODY = '00000000-0000-4000-8000-0000000000a3';
const USER = '00000000-0000-4000-8000-00000000f005';
const newRoot = useTestRoots();

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

/** Fails the first `failTimes` calls with a message that must never reach the API or the log. */
class ScriptedHandler implements ExtractionHandler {
  calls = 0;
  failTimes = 0;
  permanent = false;
  extract(): Promise<void> {
    this.calls += 1;
    if (this.permanent) return Promise.reject(new PermanentExtractionError());
    if (this.calls <= this.failTimes) return Promise.reject(new Error('SECRET invoice content'));
    return Promise.resolve();
  }
}

const pdf = (text: string) => Buffer.from(`%PDF-1.7\n${text}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('extraction queue (HTTP -> Postgres -> Redis -> worker)', () => {
  let owner: Pool;
  let pool: Pool;
  let redis: StartedTestContainer;
  let redisUrl: string;
  let root: string;
  const handler = new ScriptedHandler();
  const apps: INestApplication[] = [];
  let live: INestApplication;
  let worker: ExtractionWorker;

  const config = (url: string) => ({
    get: (key: string) =>
      ({ REDIS_URL: url, QUEUE_BACKOFF_BASE_MS: 10, DATA_DIR: root })[key] as unknown,
  });

  async function makeApp(url: string): Promise<INestApplication> {
    @Global()
    @Module({
      providers: [
        { provide: DB, useValue: drizzle(pool, { schema }) },
        TenantDbService,
        { provide: ConfigService, useValue: config(url) },
        { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
      ],
      exports: [DB, TenantDbService, ConfigService],
    })
    class RealDbModule {}

    const mod = await Test.createTestingModule({
      imports: [RealDbModule, DocumentsModule, QueueAdminModule],
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
    apps.push(app);
    return app;
  }

  const upload = (app: INestApplication, text: string, key: string, auth = 'accountant@acme') =>
    request(app.getHttpServer())
      .post('/documents/upload')
      .set('Authorization', `Bearer ${auth}`)
      .set('Idempotency-Key', key)
      .attach('file', pdf(text), { filename: 'a.pdf', contentType: 'application/pdf' });

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
  const trail = async (id: string): Promise<string[]> =>
    (
      await owner.query(
        `SELECT meta FROM audit_logs WHERE entity_id = $1 AND action = 'document.status_changed'
         ORDER BY at, id`,
        [id],
      )
    ).rows.map((r) => `${r.meta.from}>${r.meta.to}`);

  async function reset(): Promise<void> {
    await rm(path.join(root, 'tenant'), { recursive: true, force: true });
    await owner.query('DELETE FROM idempotency_keys WHERE tenant_id = ANY($1)', [[ACME, GLOBEX]]);
    await owner.query(
      `DELETE FROM audit_logs WHERE entity = 'document' AND entity_id IN
         (SELECT id FROM documents WHERE uploaded_by = $1)`,
      [USER],
    );
    await owner.query('DELETE FROM documents WHERE uploaded_by = $1', [USER]);
    handler.calls = 0;
    handler.failTimes = 0;
    handler.permanent = false;
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 1 });
    pool = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 8 });
    root = await newRoot();
    redis = await new GenericContainer('redis:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

    live = await makeApp(redisUrl);
    const processor = new ExtractionProcessor(
      live.get(TenantDbService),
      live.get(DocumentStateMachine, { strict: false }),
      handler,
    );
    worker = new ExtractionWorker(
      config(redisUrl) as unknown as ConfigService<Env, true>,
      processor,
    );
    worker.onApplicationBootstrap();
  });
  afterAll(async () => {
    await reset();
    await worker?.onApplicationShutdown();
    await Promise.all(apps.map((a) => a.close()));
    await Promise.all([owner.end(), pool.end()]);
    await redis.stop().catch(() => undefined);
  });
  beforeEach(reset);

  it('a worker that fails twice then succeeds: document ends needs_review, each attempt audited', async () => {
    handler.failTimes = 2;
    const res = await upload(live, 'flaky', 'k1').expect(201);
    expect(res.body.status).toBe('queued');

    await waitForStatus(res.body.id, 'needs_review');
    expect(handler.calls).toBe(3);
    expect(await trail(res.body.id)).toEqual([
      'uploaded>queued',
      'queued>processing',
      'processing>queued',
      'queued>processing',
      'processing>queued',
      'queued>processing',
      'processing>needs_review',
    ]);
  });

  it('runs out of 5 attempts -> failed with a code; listed for the admin, hidden from others; retry works', async () => {
    handler.failTimes = 5;
    const res = await upload(live, 'doomed', 'k1').expect(201);
    const id: string = res.body.id;
    await waitForStatus(id, 'failed');
    expect(handler.calls).toBe(5);

    const admin = (method: 'get' | 'post', url: string, who = 'tenant_admin@acme') =>
      request(live.getHttpServer())[method](url).set('Authorization', `Bearer ${who}`);

    const list = await admin('get', '/admin/jobs?state=failed').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      documentId: id,
      attemptsMade: 5,
      reason: 'EXTRACTION_RETRIES_EXHAUSTED',
    });
    // The handler's message is not stored anywhere an admin (or Redis) can read it.
    expect(JSON.stringify(list.body)).not.toContain('SECRET');
    const audit = await owner.query(
      `SELECT meta FROM audit_logs WHERE entity_id = $1 AND meta->>'to' = 'failed'`,
      [id],
    );
    expect(audit.rows[0].meta.code).toBe('EXTRACTION_RETRIES_EXHAUSTED');

    // Another tenant's admin sees nothing and cannot touch the job; a viewer is refused.
    const other = await admin('get', '/admin/jobs?state=failed', 'tenant_admin@globex').expect(200);
    expect(other.body.items).toEqual([]);
    await admin('post', `/admin/jobs/${id}/retry`, 'tenant_admin@globex').expect(404);
    await admin('get', '/admin/jobs', 'accountant@acme').expect(403);
    await admin('get', '/admin/jobs?state=active').expect(400);

    // The retry gets a fresh budget of attempts: it fails twice more, then succeeds. (With the old
    // counter, attempt 6 of 5 would have failed the job again at the first error.)
    handler.failTimes = handler.calls + 2;
    await admin('post', `/admin/jobs/${id}/retry`).expect(202);
    await waitForStatus(id, 'needs_review');
    expect(handler.calls).toBe(8);
    expect((await admin('get', '/admin/jobs').expect(200)).body.items).toEqual([]);
    await admin('post', `/admin/jobs/${id}/retry`).expect(409); // no longer failed
  });

  /** A document that ran out of attempts, plus helpers to act on it as the admin. */
  async function doomedDocument(text: string): Promise<string> {
    handler.failTimes = 99;
    const res = await upload(live, text, `k-${text}`).expect(201);
    await waitForStatus(res.body.id, 'failed');
    await sleep(300); // the worker's own 'failed' reconcile has finished; tests then change state by hand
    handler.failTimes = 0;
    return res.body.id;
  }
  const asAdmin = (app: INestApplication, method: 'get' | 'post', url: string) =>
    request(app.getHttpServer())[method](url).set('Authorization', 'Bearer tenant_admin@acme');
  async function withRedisQueue<T>(fn: (q: Queue) => Promise<T>): Promise<T> {
    const url = new URL(redisUrl);
    const q = new Queue('extraction', {
      connection: { host: url.hostname, port: Number(url.port) },
    });
    try {
      return await fn(q);
    } finally {
      await q.close();
    }
  }

  it('retry still works after the failed job expired from Redis (the job is created again)', async () => {
    const id = await doomedDocument('expired');
    await withRedisQueue(async (q) => (await q.getJob(id))?.remove());

    // The list comes from Postgres, so the failure is still visible; only the attempts are unknown.
    const list = await asAdmin(live, 'get', '/admin/jobs').expect(200);
    expect(list.body.items[0]).toMatchObject({ documentId: id, attemptsMade: null });

    await asAdmin(live, 'post', `/admin/jobs/${id}/retry`).expect(202);
    await waitForStatus(id, 'needs_review');
  });

  it('retry unsticks a document left `processing` while its job is failed in the queue', async () => {
    const id = await doomedDocument('stuck');
    // What a stalled job or a database error on the last attempt leaves behind.
    await owner.query(`UPDATE documents SET status = 'processing' WHERE id = $1`, [id]);

    await asAdmin(live, 'post', `/admin/jobs/${id}/retry`).expect(202);
    await waitForStatus(id, 'needs_review');
    const codes = (
      await owner.query(
        `SELECT meta->>'code' AS code FROM audit_logs WHERE entity_id = $1 AND meta->>'code' IS NOT NULL ORDER BY at, id`,
        [id],
      )
    ).rows.map((r) => r.code);
    expect(codes).toContain('JOB_FAILED_IN_QUEUE');
    expect(codes).toContain('MANUAL_RETRY');
  });

  it('an admin retry refuses a document whose job is not failed, and changes nothing', async () => {
    const res = await upload(live, 'busy', 'k1').expect(201);
    await waitForStatus(res.body.id, 'needs_review');
    await asAdmin(live, 'post', `/admin/jobs/${res.body.id}/retry`).expect(409);
    await owner.query(`UPDATE documents SET status = 'processing' WHERE id = $1`, [res.body.id]);
    // Job is completed, not failed: still refused, and the status is untouched.
    await asAdmin(live, 'post', `/admin/jobs/${res.body.id}/retry`).expect(409);
    expect(await statusOf(res.body.id)).toBe('processing');
  });

  it('settleFailure fails a document the queue gave up on, and leaves settled ones alone', async () => {
    const processor = new ExtractionProcessor(
      live.get(TenantDbService),
      live.get(DocumentStateMachine, { strict: false }),
      handler,
    );
    const done = await upload(live, 'fine', 'k1').expect(201);
    await waitForStatus(done.body.id, 'needs_review');
    await processor.settleFailure(
      { documentId: done.body.id, tenantId: ACME },
      'EXTRACTION_STALLED',
    );
    expect(await statusOf(done.body.id)).toBe('needs_review');

    await owner.query(`UPDATE documents SET status = 'processing' WHERE id = $1`, [done.body.id]);
    await processor.settleFailure(
      { documentId: done.body.id, tenantId: ACME },
      'EXTRACTION_STALLED',
    );
    expect(await statusOf(done.body.id)).toBe('failed');
    const failed = await owner.query(
      `SELECT meta FROM audit_logs WHERE entity_id = $1 AND meta->>'to' = 'failed'`,
      [done.body.id],
    );
    expect(failed.rows[0].meta.code).toBe('EXTRACTION_STALLED');
  });

  it('admin endpoints with Redis unreachable: the list still answers, retry is 503 and changes nothing', async () => {
    const id = await doomedDocument('redis-gone');
    const dead = await makeApp('redis://127.0.0.1:1');

    const list = await asAdmin(dead, 'get', '/admin/jobs').expect(200);
    expect(list.body.items[0]).toMatchObject({ documentId: id, attemptsMade: null });

    const started = Date.now();
    const res = await asAdmin(dead, 'post', `/admin/jobs/${id}/retry`).expect(503);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.body).toMatchObject({ status: 503, code: 'QUEUE_UNAVAILABLE' });
    expect(await statusOf(id)).toBe('failed');
  });

  it('a permanent error fails the job on the first attempt, with its own code', async () => {
    handler.permanent = true;
    const res = await upload(live, 'bad', 'k1').expect(201);
    await waitForStatus(res.body.id, 'failed');
    expect(handler.calls).toBe(1);
    const list = await request(live.getHttpServer())
      .get('/admin/jobs')
      .set('Authorization', 'Bearer tenant_admin@acme')
      .expect(200);
    expect(list.body.items[0]).toMatchObject({ attemptsMade: 1, reason: 'EXTRACTION_FAILED' });
  });

  it('the same file twice (new key, replayed key) starts exactly one job', async () => {
    const first = await upload(live, 'once', 'k1').expect(201);
    await upload(live, 'once', 'k2').expect(200);
    await upload(live, 'once', 'k1').expect(201); // replay of the first request
    await waitForStatus(first.body.id, 'needs_review');
    await sleep(300); // a second job, if one existed, would have run by now
    expect(handler.calls).toBe(1);
    // The worker would skip a second job, so count the jobs themselves: one per document id.
    const url = new URL(redisUrl);
    const probe = new Queue('extraction', {
      connection: { host: url.hostname, port: Number(url.port) },
    });
    try {
      const jobs = await probe.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']);
      expect(jobs.filter((j) => j.data.documentId === first.body.id)).toHaveLength(1);
    } finally {
      await probe.close();
    }
    expect(await trail(first.body.id)).toEqual([
      'uploaded>queued',
      'queued>processing',
      'processing>needs_review',
    ]);
  });

  it('enqueueing the same document twice leaves one job (the job id is the document id)', async () => {
    const queue = live.get(EXTRACTION_QUEUE_PORT);
    const data = { documentId: '00000000-0000-4000-8000-0000000000e1', tenantId: NOBODY };
    await Promise.all([queue.enqueue(data), queue.enqueue(data), queue.enqueue(data)]);
    await sleep(300); // the worker fails it (no such document); that does not matter here
    const url = new URL(redisUrl);
    const probe = new Queue('extraction', {
      connection: { host: url.hostname, port: Number(url.port) },
    });
    try {
      const jobs = await probe.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']);
      expect(jobs.filter((j) => j.data.documentId === data.documentId)).toHaveLength(1);
    } finally {
      await probe.close();
    }
  });

  it('a job delivered again after the document is settled does nothing (idempotent worker)', async () => {
    const res = await upload(live, 'twice', 'k1').expect(201);
    await waitForStatus(res.body.id, 'needs_review');
    const processor = new ExtractionProcessor(
      live.get(TenantDbService),
      live.get(DocumentStateMachine, { strict: false }),
      handler,
    );
    await processor.process(
      { documentId: res.body.id, tenantId: ACME },
      { attempt: 1, maxAttempts: 5 },
    );
    expect(handler.calls).toBe(1);
    expect(await statusOf(res.body.id)).toBe('needs_review');
  });

  it('Redis unreachable -> 503 QUEUE_UNAVAILABLE fast; resending the upload later starts the job', async () => {
    const dead = await makeApp('redis://127.0.0.1:1');
    const started = Date.now();
    const res = await upload(dead, 'outage', 'k1').expect(503);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.body).toMatchObject({ status: 503, code: 'QUEUE_UNAVAILABLE' });
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');

    // The row committed and is `queued` with no job; reads still work without Redis.
    const row = (
      await owner.query(`SELECT id, status FROM documents WHERE uploaded_by = $1`, [USER])
    ).rows[0];
    expect(row.status).toBe('queued');
    expect(handler.calls).toBe(0);

    // Same request again, Redis back: the duplicate path sends the missing job.
    const retry = await upload(live, 'outage', 'k1').expect(201);
    expect(retry.body.id).toBe(row.id);
    await waitForStatus(row.id, 'needs_review');
    expect(handler.calls).toBe(1);
  });

  it('Redis dies while the API is connected -> 503 within seconds, not a hang', async () => {
    // Its own Redis and no worker: the shared Redis must stay up so the worker shuts down cleanly.
    const doomed = await new GenericContainer('redis:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    const app = await makeApp(`redis://${doomed.getHost()}:${doomed.getMappedPort(6379)}`);
    await upload(app, 'before', 'k1').expect(201); // the API is connected and working

    await doomed.stop();
    const started = Date.now();
    const res = await upload(app, 'killed', 'k2').expect(503);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.body.code).toBe('QUEUE_UNAVAILABLE');
  });
});
