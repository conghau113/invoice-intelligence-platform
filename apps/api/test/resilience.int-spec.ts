/**
 * T6.2 against real Postgres (app role, RLS), a real Redis and a real BullMQ worker: upload ->
 * queue -> ExtractionWorker -> AiExtractionHandler -> HttpAiExtractor -> a local HTTP stand-in for
 * the AI service. Only the AI service is replaced; its own Retry-After handling is in pytest.
 *
 *  - The provider answers 429 to 30% of the calls (a fixed pattern, not a random draw, so the run
 *    is the same every time): every document still ends `needs_review`, none uses an attempt on a
 *    429, and no window of one "minute" holds more calls than the plan allows. The minute is
 *    shortened to five seconds (PROVIDER_MINUTE_MS) so this runs in seconds.
 *  - The AI service is down: after BREAKER_THRESHOLD failures in a row the circuit opens and no call
 *    reaches it for the cooldown; then one probe, and once it answers the queue drains.
 */
import { disabledResultCache } from '../src/modules/cache/testing/no-cache';
import { Logger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import type { StartedTestContainer } from 'testcontainers';
import type { Env } from '../src/config/env.schema';
import { TenantDbService } from '../src/db/tenant-db.service';
import { DocumentStateMachine } from '../src/modules/documents/application/document-state-machine';
import { DocumentsModule } from '../src/modules/documents/documents.module';
import { AiExtractionHandler } from '../src/modules/extraction/application/ai-extraction.handler';
import { HttpAiExtractor } from '../src/modules/extraction/infra/http-ai-extractor';
import { ExtractionProcessor } from '../src/modules/queue/application/extraction.processor';
import { EXTRACTION_QUEUE } from '../src/modules/queue/domain/extraction-job';
import { ExtractionWorker } from '../src/modules/queue/infra/extraction-worker';
import { ProviderGuard } from '../src/modules/queue/infra/provider-guard';
import { workerConnection } from '../src/modules/queue/infra/redis-connection';
import { STORAGE_PORT } from '../src/modules/storage/application/storage.port';
import { LocalFsStorage } from '../src/modules/storage/infra/local-fs.storage';
import { useTestRoots } from '../src/modules/storage/testing/test-root';
import { queueReady } from './support/queue-ready';
import { startRedis } from './support/reachable-container';
import {
  UNLIMITED_PROVIDER,
  deleteDocumentsOf,
  realDbModule,
  stubAuthProviders,
  withoutCache,
} from './support/test-app';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-00000000f0c2';
const AI_TOKEN = 'integration-token-0123456789';
const newRoot = useTestRoots();
const INVOICE: unknown = JSON.parse(
  readFileSync(
    path.join(__dirname, '../../../packages/contracts/fixtures/invoice.valid.json'),
    'utf8',
  ),
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

/** Calls 4, 7 and 10 of every ten: 30% of the calls, the same pattern on every run. */
const isRateLimitedCall = (n: number) => (n * 3) % 10 < 3;

/** Most calls found in any closed window of `windowMs` (`times` sorted). */
function busiestWindow(times: number[], windowMs: number): number {
  let best = 0;
  let from = 0;
  for (let to = 0; to < times.length; to++) {
    while ((times[to] ?? 0) - (times[from] ?? 0) > windowMs) from += 1;
    best = Math.max(best, to - from + 1);
  }
  return best;
}

type Mode = 'rate-limited-30' | 'down' | 'ok';

describe('provider resilience (T6.2: pacing, 429, circuit breaker)', () => {
  let owner: Pool;
  let pool: Pool;
  let redis: StartedTestContainer;
  let redisUrl: string;
  let root: string;
  let ai: Server;
  let app: INestApplication;
  let worker: ExtractionWorker | undefined;
  let admin: Queue;
  /** BullMQ does not close a connection it was given: this one is closed by hand in afterAll. */
  let adminConnection: Redis;

  let mode: Mode = 'ok';
  /** Arrival time of every call the stand-in AI service received. */
  let calls: number[] = [];
  /** The X-Tenant-Id of every call (T7.2: the AI service logs it as tenant_id). */
  let tenants: (string | undefined)[] = [];

  const env = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    REDIS_URL: redisUrl,
    QUEUE_BACKOFF_BASE_MS: 10,
    DATA_DIR: root,
    AI_SERVICE_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
    AI_SERVICE_TOKEN: AI_TOKEN,
    ...UNLIMITED_PROVIDER,
    ...over,
  });
  const settings = (over: Record<string, unknown>) => {
    const values = env(over);
    return { get: (key: string) => values[key] };
  };

  /** The worker side as src/worker.ts wires it, with these limits. */
  function startWorker(over: Record<string, unknown>): ExtractionWorker {
    const config = settings(over) as unknown as ConfigService<Env, true>;
    const tenantDb = app.get(TenantDbService);
    const handler = new AiExtractionHandler(
      tenantDb,
      new LocalFsStorage(root),
      new HttpAiExtractor(config),
      disabledResultCache(),
    );
    const w = new ExtractionWorker(
      config,
      new ExtractionProcessor(tenantDb, app.get(DocumentStateMachine, { strict: false }), handler),
    );
    w.onApplicationBootstrap();
    return w;
  }

  const uploadPdf = () => {
    const key = randomUUID();
    return request(app.getHttpServer())
      .post('/documents/upload')
      .set('Authorization', 'Bearer accountant')
      .set('Idempotency-Key', key)
      .attach('file', Buffer.from(`%PDF-1.7\nSAMPLE ${key}\n`), {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
  };

  const statuses = async (ids: string[]) =>
    (await owner.query('SELECT status FROM documents WHERE id = ANY($1)', [ids])).rows.map(
      (r: { status: string }) => r.status,
    );
  async function waitAll(ids: string[], want: string, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if ((await statuses(ids)).every((s) => s === want)) return;
      await sleep(50);
    }
    throw new Error(`not all ${want}: ${(await statuses(ids)).join(',')}`);
  }
  /** Audit codes written for these documents, counted. */
  async function auditCodes(ids: string[]): Promise<Record<string, number>> {
    const { rows } = await owner.query(
      `SELECT meta->>'code' AS code, count(*)::int AS n FROM audit_logs
        WHERE entity_id = ANY($1) AND meta ? 'code' GROUP BY 1`,
      [ids],
    );
    return Object.fromEntries(rows.map((r: { code: string; n: number }) => [r.code, r.n]));
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 1 });
    pool = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 8 });
    root = await newRoot();

    ai = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        calls.push(Date.now());
        const tenant = req.headers['x-tenant-id'];
        tenants.push(typeof tenant === 'string' ? tenant : undefined);
        const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
          res
            .writeHead(status, { 'content-type': 'application/json', ...headers })
            .end(JSON.stringify(payload));
        if (mode === 'down') return json(503, { code: 'LLM_UNAVAILABLE', message: 'x' });
        if (mode === 'rate-limited-30' && isRateLimitedCall(calls.length)) {
          return json(503, { code: 'LLM_RATE_LIMITED', message: 'x' }, { 'retry-after': '1' });
        }
        json(200, { invoice: INVOICE, warnings: [], usage: null });
      });
    });
    await new Promise<void>((r) => ai.listen(0, '127.0.0.1', r));

    redis = await startRedis();
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

    const mod = await withoutCache(
      Test.createTestingModule({
        imports: [realDbModule(pool, env()), DocumentsModule],
        providers: stubAuthProviders(USER, { acme: ACME }),
      }),
    )
      .overrideProvider(STORAGE_PORT)
      .useValue(new LocalFsStorage(root))
      .compile();
    app = mod.createNestApplication();
    await app.init();
    await queueReady(app);
    adminConnection = workerConnection(redisUrl);
    admin = new Queue(EXTRACTION_QUEUE, { connection: adminConnection });
  }, 120_000);

  afterEach(async () => {
    await worker?.onApplicationShutdown();
    worker = undefined;
    await admin.obliterate({ force: true });
    await admin.removeRateLimitKey();
    await owner.query('DELETE FROM idempotency_keys WHERE tenant_id = $1', [ACME]);
    await deleteDocumentsOf(owner, USER);
    await rm(path.join(root, 'tenant'), { recursive: true, force: true });
    calls = [];
    tenants = [];
    mode = 'ok';
  });

  afterAll(async () => {
    await admin?.close();
    adminConnection?.disconnect();
    await app?.close();
    await new Promise<void>((r) => ai.close(() => r()));
    await Promise.all([owner.end(), pool.end()]);
    await redis?.stop().catch(() => undefined);
  });

  it('429 on 30% of calls: every document succeeds, no attempt is used, no minute goes over the RPM', async () => {
    // A "minute" of 5 s: long enough that the 1 s holds after each 429 cannot pace the calls on
    // their own (they did with a 1 s minute, so a run without the limiter still passed).
    const RPM = 10;
    const MINUTE_MS = 5_000;
    mode = 'rate-limited-30';
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await uploadPdf()).body.id as string);
    worker = startWorker({ LLM_RPM: RPM, PROVIDER_MINUTE_MS: MINUTE_MS });

    await waitAll(ids, 'needs_review', 60_000);

    const limited = calls.filter((_, i) => isRateLimitedCall(i + 1)).length;
    expect(calls.length).toBe(ids.length + limited); // each 429 was asked again, once
    expect(limited).toBeGreaterThanOrEqual(5);
    // A 429 sent the job back to the queue; it never counted as a failed attempt.
    const codes = await auditCodes(ids);
    expect(codes.EXTRACTION_RATE_LIMITED).toBe(limited);
    expect(codes.EXTRACTION_RETRY).toBeUndefined();
    // The plan: at most RPM calls in any window of one (shortened) minute, 429s included.
    expect(busiestWindow(calls, MINUTE_MS)).toBeLessThanOrEqual(RPM);
  }, 90_000);

  it('a down AI service opens the circuit: no call during the cooldown, then a probe, then the queue drains', async () => {
    const THRESHOLD = 3;
    const COOLDOWN_MS = 2_000;
    mode = 'down';
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await uploadPdf()).body.id as string);
    worker = startWorker({ BREAKER_THRESHOLD: THRESHOLD, BREAKER_COOLDOWN_MS: COOLDOWN_MS });

    // The failures that open it. With two jobs at a time a fourth call may already be on its way.
    const until = Date.now() + 10_000;
    while (calls.length < THRESHOLD && Date.now() < until) await sleep(10);
    expect(calls.length).toBeGreaterThanOrEqual(THRESHOLD);
    // The service comes back at once, but the breaker does not know yet.
    mode = 'ok';

    await waitAll(ids, 'needs_review', 20_000);
    // Retries without the breaker come back within milliseconds (backoff base 10 ms). The open
    // circuit shows as one silence of a whole cooldown, after the failures that opened it.
    const gaps = calls.slice(1).map((t, i) => t - (calls[i] ?? t));
    const longest = Math.max(...gaps);
    expect(longest).toBeGreaterThanOrEqual(COOLDOWN_MS - 100);
    expect(gaps.indexOf(longest)).toBeGreaterThanOrEqual(THRESHOLD - 1);
    // No document was failed by the breaker: waiting in the queue cost no attempt.
    expect(await statuses(ids)).toEqual(ids.map(() => 'needs_review'));
  }, 60_000);

  it('every AI call of a job names the job tenant (X-Tenant-Id), retries included (T7.2)', async () => {
    mode = 'down'; // a few failed attempts first: the retries must carry it too
    const ids = [(await uploadPdf()).body.id as string, (await uploadPdf()).body.id as string];
    worker = startWorker({ BREAKER_THRESHOLD: 100 });
    const until = Date.now() + 10_000;
    while (calls.length < 3 && Date.now() < until) await sleep(10);
    mode = 'ok';
    await waitAll(ids, 'needs_review', 20_000);
    expect(tenants.length).toBeGreaterThanOrEqual(ids.length + 1);
    expect(new Set(tenants)).toEqual(new Set([ACME]));
  }, 40_000);

  it('a short hold never shortens a longer one already on the queue (two 429s at once)', async () => {
    const guard = new ProviderGuard(admin, adminConnection, new Logger('test'), {
      threshold: 100,
      cooldownMs: 100,
    });
    const ttl = () => adminConnection.pttl(admin.keys.limiter ?? '');
    expect(await guard.hold(5_000)).toBe(true);
    expect(await guard.hold(100)).toBe(true);
    expect(await ttl()).toBeGreaterThan(4_000);
    // And a longer one does extend a short one.
    await admin.removeRateLimitKey();
    await guard.hold(100);
    await guard.hold(5_000);
    expect(await ttl()).toBeGreaterThan(4_000);
  });
});
