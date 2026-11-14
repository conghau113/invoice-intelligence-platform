/**
 * Rate limiting (T6.1, ADR 0012) against a real Redis in a container.
 *
 * - The Lua token bucket on its own: concurrent callers on several connections (as several API
 *   instances would be) never get more tokens than the bucket holds, a refused take touches
 *   neither bucket, the bucket refills at its rate and Retry-After is long enough.
 * - The real AuthModule guard chain over the real controllers (only the services behind them are
 *   stubbed): /qa/ask, upload, approve and reopen answer 429 with Retry-After once their bucket
 *   is empty, and a refused caller spends no token.
 * - Redis stopped: reads go on, Q&A is refused with 503 (fail open / fail closed).
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import type { StartedTestContainer } from 'testcontainers';
import { ProblemDetailsFilter } from '../src/common/http/problem-details.filter';
import { TENANT_DIRECTORY } from '../src/modules/auth/application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../src/modules/auth/application/token-verifier.port';
import { AuthModule } from '../src/modules/auth/auth.module';
import { DocumentFileService } from '../src/modules/documents/application/document-file.service';
import { DocumentsListService } from '../src/modules/documents/application/documents-list.service';
import { DocumentsService } from '../src/modules/documents/application/documents.service';
import { DocumentsController } from '../src/modules/documents/http/documents.controller';
import { QaModelUnavailableError } from '../src/modules/qa/application/qa-model.port';
import { QaService } from '../src/modules/qa/application/qa.service';
import { QaController } from '../src/modules/qa/http/qa.controller';
import { producerConnection } from '../src/modules/queue/infra/redis-connection';
import {
  RATE_LIMITER,
  RateLimiterUnavailableError,
  type RateLimiterPort,
  type TakeRequest,
  type TakeResult,
} from '../src/modules/rate-limit/application/rate-limiter.port';
import { POLICIES, refillPerSecond, type Bucket } from '../src/modules/rate-limit/domain/policies';
import { RedisRateLimiter } from '../src/modules/rate-limit/infra/redis-rate-limiter';
import { ApproveService } from '../src/modules/review/application/approve.service';
import { ReopenService } from '../src/modules/review/application/reopen.service';
import { ReviewController } from '../src/modules/review/http/review.controller';
import { startRedis } from './support/reachable-container';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const DOC = '00000000-0000-4000-8000-00000000d0c1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until the limiter's connection answers. Like the queue producer (support/queue-ready.ts),
 * it fails fast instead of queueing commands, so a take sent before it has connected is refused.
 */
async function limiterReady(limiter: RateLimiterPort, ms = 10_000): Promise<void> {
  const probe: TakeRequest = {
    userKey: 'rl:test:{ready}:u',
    tenantKey: 'rl:test:{ready}:t',
    user: { capacity: 1_000_000, windowSeconds: 1 },
    tenant: { capacity: 1_000_000, windowSeconds: 1 },
  };
  const until = Date.now() + ms;
  for (;;) {
    try {
      await limiter.take(probe);
      return;
    } catch (e) {
      if (Date.now() >= until) throw e;
      await sleep(25);
    }
  }
}

let seq = 0;
/** Fresh keys per test, so tests share one Redis without sharing buckets. */
function keys(user = 'u'): Pick<TakeRequest, 'userKey' | 'tenantKey'> {
  seq += 1;
  return { userKey: `rl:test:{t${seq}}:u:${user}`, tenantKey: `rl:test:{t${seq}}:t` };
}

describe('rate limiting (Redis token buckets)', () => {
  let redis: StartedTestContainer;
  let url: string;
  /** Several limiters, each with its own connection: what several API instances would be. */
  let limiters: RedisRateLimiter[];
  let inspect: Redis;
  let redisStopped = false;

  beforeAll(async () => {
    redis = await startRedis();
    url = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    limiters = Array.from({ length: 4 }, () => new RedisRateLimiter(producerConnection(url)));
    inspect = new Redis(url);
    await Promise.all(limiters.map((l) => limiterReady(l)));
  }, 120_000);

  afterAll(async () => {
    for (const l of limiters) l.onApplicationShutdown();
    inspect.disconnect();
    if (!redisStopped) await redis?.stop();
  });

  /** The i-th "API instance", round robin. */
  const instance = (i: number): RedisRateLimiter => {
    const limiter = limiters[i % limiters.length];
    if (limiter === undefined) throw new Error('no limiters');
    return limiter;
  };
  const takeAll = (requests: TakeRequest[]): Promise<TakeResult[]> =>
    Promise.all(requests.map((r, i) => instance(i).take(r)));

  describe('the Lua token bucket', () => {
    it('200 concurrent takes on a bucket of 50 let exactly 50 through', async () => {
      const k = keys();
      // Refills 0.01 token a second, so the count below cannot drift even on a slow machine.
      const big = { capacity: 10_000, windowSeconds: 1_000_000 };
      const req: TakeRequest = { ...k, user: { capacity: 50, windowSeconds: 3600 }, tenant: big };

      const results = await takeAll(Array.from({ length: 200 }, () => req));

      expect(results.filter((r) => r.allowed)).toHaveLength(50);
      // Refused takes did not spend tenant tokens: exactly 50 left the tenant bucket.
      const tenantTokens = Number(await inspect.hget(k.tenantKey, 'tokens'));
      expect(Math.floor(tenantTokens)).toBe(10_000 - 50);
    });

    it('the tenant bucket caps several users together, and a refused take spends nothing', async () => {
      seq += 1;
      const tenantKey = `rl:test:{t${seq}}:t`;
      const users = ['a', 'b', 'c', 'd'].map((u) => `rl:test:{t${seq}}:u:${u}`);
      const perUser = { capacity: 50, windowSeconds: 3600 };
      const tenant = { capacity: 60, windowSeconds: 3600 };
      const requests = users.flatMap((userKey) =>
        Array.from({ length: 50 }, () => ({ userKey, tenantKey, user: perUser, tenant })),
      );

      const results = await takeAll(requests);

      expect(results.filter((r) => r.allowed)).toHaveLength(60);
      // Each user bucket lost exactly the tokens of its own allowed takes.
      for (const userKey of users) {
        const allowed = results.filter((r, i) => r.allowed && requests[i]?.userKey === userKey);
        const tokens = Number(await inspect.hget(userKey, 'tokens'));
        expect(Math.floor(tokens + 1e-6)).toBe(50 - allowed.length);
      }
    });

    it('refills at capacity per window, and Retry-After is long enough to get a token', async () => {
      const k = keys();
      const bucket = { capacity: 2, windowSeconds: 1 }; // one token every 500 ms
      const req: TakeRequest = { ...k, user: bucket, tenant: { capacity: 100, windowSeconds: 1 } };

      expect((await instance(0).take(req)).allowed).toBe(true);
      const second = await instance(1).take(req);
      expect(second).toMatchObject({ allowed: true, user: { remaining: 0 } });
      // A little under 1 s: the first token has been refilling since the first take.
      expect(second.user.fullInMs).toBeGreaterThan(0);
      expect(second.user.fullInMs).toBeLessThanOrEqual(1000);

      const refused = await instance(2).take(req);
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterMs).toBeGreaterThan(0);
      expect(refused.retryAfterMs).toBeLessThanOrEqual(500);

      await sleep(refused.retryAfterMs + 20);
      expect((await instance(3).take(req)).allowed).toBe(true);
    });

    it('keys expire once the bucket would be full again', async () => {
      const k = keys();
      const req: TakeRequest = {
        ...k,
        user: { capacity: 10, windowSeconds: 60 },
        tenant: { capacity: 100, windowSeconds: 60 },
      };
      await instance(0).take(req);
      // One token short of full: 6 s to refill, plus the 1 s margin.
      const ttl = await inspect.pttl(k.userKey);
      expect(ttl).toBeGreaterThan(6_000);
      expect(ttl).toBeLessThanOrEqual(7_000);
    });
  });

  describe('HTTP: real guard chain and controllers', () => {
    let app: INestApplication;
    const qaCalls: string[] = [];

    beforeAll(async () => {
      const values: Record<string, unknown> = { REDIS_URL: url, DEMO_READ_ONLY: false };
      @Global()
      @Module({
        providers: [{ provide: ConfigService, useValue: { get: (k: string) => values[k] } }],
        exports: [ConfigService],
      })
      class FakeConfigModule {}

      const mod = await Test.createTestingModule({
        imports: [FakeConfigModule, AuthModule],
        controllers: [QaController, ReviewController, DocumentsController],
        providers: [
          {
            provide: QaService,
            useValue: {
              // The limiter let the call through; the model is "down" so no stream is needed.
              ask: (tenantId: string) => {
                qaCalls.push(tenantId);
                return Promise.reject(new QaModelUnavailableError());
              },
            },
          },
          {
            provide: ApproveService,
            useValue: { approve: () => Promise.resolve({ corrections: 0 }) },
          },
          { provide: ReopenService, useValue: { reopen: () => Promise.resolve({ version: 2 }) } },
          {
            provide: DocumentsService,
            useValue: {
              create: () =>
                Promise.resolve({
                  statusCode: 201,
                  replayed: false,
                  document: { id: DOC, status: 'queued' },
                }),
            },
          },
          { provide: DocumentsListService, useValue: { list: () => Promise.resolve({}) } },
          { provide: DocumentFileService, useValue: {} },
          { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        ],
      })
        // Bearer token "<role>:<user id>:<tenant alias>".
        .overrideProvider(TOKEN_VERIFIER)
        .useValue({
          verify: (token: string) => {
            const [role, sub, org] = token.split(':');
            return Promise.resolve({ sub, organization: [org], realm_access: { roles: [role] } });
          },
        })
        .overrideProvider(TENANT_DIRECTORY)
        .useValue({
          idForAlias: (a: string) => Promise.resolve({ acme: ACME, globex: GLOBEX }[a]),
        })
        .compile();
      app = mod.createNestApplication();
      await app.init();
      await limiterReady(app.get<RateLimiterPort>(RATE_LIMITER));
    });

    afterAll(() => app.close());

    let userSeq = 0;
    /** A user nobody else in this file uses, so their buckets start full. */
    const freshUser = () => {
      userSeq += 1;
      return `44444444-4444-4444-8444-${String(userSeq).padStart(12, '0')}`;
    };
    const as = (role: string, user: string, tenant = 'acme') => `Bearer ${role}:${user}:${tenant}`;
    const server = () => request(app.getHttpServer());

    /**
     * Sends one request after another until the first 429 and checks how many passed against the
     * bucket: at least its capacity (a full bucket takes a burst), at most the capacity plus what
     * refilled while the requests were sent. Not a fixed number: on a slow machine 60 uploads take
     * more than a second and the upload bucket gains a token every second.
     */
    async function drain(
      send: (i: number) => request.Test,
      bucket: Bucket,
      passStatus: number,
    ): Promise<{ passed: number; limited: request.Response }> {
      const started = Date.now();
      for (let i = 0; i < bucket.capacity * 2; i++) {
        const res = await send(i);
        if (res.status === 429) {
          const refilled = Math.ceil(((Date.now() - started) / 1000) * refillPerSecond(bucket));
          expect(i).toBeGreaterThanOrEqual(bucket.capacity);
          expect(i).toBeLessThanOrEqual(bucket.capacity + refilled);
          return { passed: i, limited: res };
        }
        expect(res.status).toBe(passStatus);
      }
      throw new Error(`no 429 after ${bucket.capacity * 2} requests`);
    }

    it('/qa/ask: a full bucket of questions reaches the service, then 429 with Retry-After', async () => {
      const user = freshUser();
      qaCalls.length = 0;
      const ask = () =>
        server()
          .post('/qa/ask')
          .set('Authorization', as('viewer', user))
          .send({ question: 'Tổng tiền tháng 3?' });

      // 503: the question got past the limiter and reached the (stubbed, down) model.
      const { passed, limited: res } = await drain(ask, POLICIES.qa.user, 503);

      expect(res.body).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
      // One token every 12 s: the wait is a whole number of seconds between 1 and 12.
      const retryAfter = Number(res.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(12);
      expect(res.headers['ratelimit']).toMatch(/^"qa-user";r=0;t=\d+, "qa-tenant";r=\d+;t=\d+$/);
      // The refused question never reached the model.
      expect(qaCalls).toHaveLength(passed);
    });

    it('approve and reopen share the write bucket, then both are 429', async () => {
      const user = freshUser();
      const send = (i: number) =>
        server()
          .post(i % 2 === 0 ? `/documents/${DOC}/approve` : `/documents/${DOC}/reopen`)
          .set('Authorization', as('accountant', user))
          .set('If-Match', '"1"')
          .send({});

      const { limited } = await drain(send, POLICIES.write.user, 200);

      expect(limited.body.code).toBe('RATE_LIMITED');
      expect(limited.headers['retry-after']).toBeDefined();
      // Whichever of the two was refused, the other one is refused too: one bucket.
      await send(0).expect(429);
      await send(1).expect(429);
    });

    it('upload: a burst of a full bucket passes (the 50-file demo fits), then 429', async () => {
      const user = freshUser();
      const upload = (i: number) =>
        server()
          .post('/documents/upload')
          .set('Authorization', as('accountant', user))
          .set('Idempotency-Key', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
          .attach('file', Buffer.from('%PDF-1.7\nSAMPLE\n'), 'sample.pdf');

      const { passed, limited } = await drain(upload, POLICIES.upload.user, 201);

      expect(passed).toBeGreaterThanOrEqual(50);
      expect(limited.body.code).toBe('RATE_LIMITED');
    });

    it('a forbidden caller spends no token from the bucket of the route', async () => {
      const user = freshUser();
      // viewer may not approve: 403 every time, and the write bucket stays full.
      for (let i = 0; i < 25; i++) {
        await server()
          .post(`/documents/${DOC}/approve`)
          .set('Authorization', as('viewer', user))
          .set('If-Match', '"1"')
          .send({})
          .expect(403);
      }
      const keys = await inspect.keys(`rl:v1:{${ACME}}:u:${user}:*`);
      expect(keys).toEqual([]);
    });

    it('buckets are per tenant: the same user id in another tenant has its own', async () => {
      const user = freshUser();
      const ask = (tenant: string) => () =>
        server()
          .post('/qa/ask')
          .set('Authorization', as('viewer', user, tenant))
          .send({ question: 'q' });
      await drain(ask('acme'), POLICIES.qa.user, 503);
      await ask('globex')().expect(503); // reached the (stubbed, down) model: not rate limited
    });

    it('Redis stopped: reads fail open, Q&A fails closed with 503 RATE_LIMIT_UNAVAILABLE', async () => {
      await redis.stop();
      redisStopped = true;
      const user = freshUser();
      const started = Date.now();

      await server().get('/documents').set('Authorization', as('viewer', user)).expect(200);
      const qa = await server()
        .post('/qa/ask')
        .set('Authorization', as('viewer', user))
        .send({ question: 'q' })
        .expect(503);
      expect(qa.body.code).toBe('RATE_LIMIT_UNAVAILABLE');
      // Neither request waited for Redis to come back (each command gives up after 2 s at most).
      expect(Date.now() - started).toBeLessThan(10_000);

      await expect(
        instance(0).take({ ...keys(), user: POLICIES.qa.user, tenant: POLICIES.qa.tenant }),
      ).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    });
  });
});
