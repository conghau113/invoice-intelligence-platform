import type { INestApplication } from '@nestjs/common';
import { Controller, Get, Post } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProblemDetailsFilter } from '../../../common/http/problem-details.filter';
import { TENANT_DIRECTORY } from '../../auth/application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../../auth/application/token-verifier.port';
import { JwtAuthGuard } from '../../auth/http/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/http/permissions.guard';
import { Public } from '../../auth/http/public.decorator';
import { RequirePermission } from '../../auth/http/require-permission.decorator';
import {
  RATE_LIMITER,
  RateLimiterUnavailableError,
  type RateLimiterPort,
  type TakeRequest,
  type TakeResult,
} from '../application/rate-limiter.port';
import { POLICIES } from '../domain/policies';
import { RateLimit } from './rate-limit.decorator';
import { RateLimitGuard } from './rate-limit.guard';

const ACME_ID = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX_ID = '00000000-0000-4000-8000-0000000000a2';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

@Controller('probe')
class ProbeController {
  @RequirePermission('document:read')
  @Get('read')
  read(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('document:approve')
  @Post('write')
  write(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('qa:ask')
  @RateLimit('qa')
  @Post('ask')
  ask(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('qa:ask')
  @RateLimit('upload')
  @Get('upload-class')
  uploadClass(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Counts tokens per key with no refill, so a test can drain a bucket in a few calls. `down` makes
 * it fail the way the Redis adapter does when Redis does not answer. The atomic Lua version is
 * tested against a real Redis in test/rate-limit.int-spec.ts.
 */
class CountingLimiter implements RateLimiterPort {
  readonly used = new Map<string, number>();
  readonly calls: TakeRequest[] = [];
  down = false;
  retryAfterMs = 4_200;

  take(req: TakeRequest): Promise<TakeResult> {
    this.calls.push(req);
    if (this.down) return Promise.reject(new RateLimiterUnavailableError());
    const user = this.used.get(req.userKey) ?? 0;
    const tenant = this.used.get(req.tenantKey) ?? 0;
    const allowed = user < req.user.capacity && tenant < req.tenant.capacity;
    if (allowed) {
      this.used.set(req.userKey, user + 1);
      this.used.set(req.tenantKey, tenant + 1);
    }
    const after = (key: string, capacity: number) => capacity - (this.used.get(key) ?? 0);
    return Promise.resolve({
      allowed,
      retryAfterMs: allowed ? 0 : this.retryAfterMs,
      user: { remaining: after(req.userKey, req.user.capacity), fullInMs: 1_500 },
      tenant: { remaining: after(req.tenantKey, req.tenant.capacity), fullInMs: 500 },
    });
  }

  reset(): void {
    this.used.clear();
    this.calls.length = 0;
    this.down = false;
  }
}

describe('RateLimitGuard (real auth guards + filter, counting limiter)', () => {
  let app: INestApplication;
  const limiter = new CountingLimiter();

  beforeAll(async () => {
    // Bearer token "<role>:<user id>:<tenant alias>".
    const verifier = {
      verify: (token: string) => {
        const [role, sub, org] = token.split(':');
        return Promise.resolve({ sub, organization: [org], realm_access: { roles: [role] } });
      },
    };
    const ids: Record<string, string> = { acme: ACME_ID, globex: GLOBEX_ID };
    const mod = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: TOKEN_VERIFIER, useValue: verifier },
        {
          provide: TENANT_DIRECTORY,
          useValue: { idForAlias: (a: string) => Promise.resolve(ids[a]) },
        },
        { provide: RATE_LIMITER, useValue: limiter },
        // Same order as AuthModule.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => limiter.reset());

  const token = (role: string, user = ALICE, tenant = 'acme') => `${role}:${user}:${tenant}`;
  const call = (method: 'get' | 'post', path: string, bearer?: string) => {
    const req = request(app.getHttpServer())[method](path);
    return bearer ? req.set('Authorization', `Bearer ${bearer}`) : req;
  };

  it('over the qa limit -> 429 RATE_LIMITED with Retry-After and RateLimit headers', async () => {
    const { capacity } = POLICIES.qa.user;
    for (let i = 0; i < capacity; i++) {
      await call('post', '/probe/ask', token('viewer')).expect(201);
    }
    const res = await call('post', '/probe/ask', token('viewer')).expect(429);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      status: 429,
      title: 'Too Many Requests',
      code: 'RATE_LIMITED',
    });
    // 4 200 ms rounds UP to 5 s: a client that waits the advertised time must find a token.
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['ratelimit-policy']).toBe(
      `"qa-user";q=${capacity};w=60, "qa-tenant";q=${POLICIES.qa.tenant.capacity};w=60`,
    );
    expect(res.headers['ratelimit']).toBe(
      `"qa-user";r=0;t=2, "qa-tenant";r=${POLICIES.qa.tenant.capacity - capacity};t=1`,
    );
  });

  it('a request that passes also carries the RateLimit headers, and no Retry-After', async () => {
    const res = await call('get', '/probe/read', token('viewer')).expect(200);
    expect(res.headers['ratelimit']).toBe(
      `"read-user";r=${POLICIES.read.user.capacity - 1};t=2, "read-tenant";r=${POLICIES.read.tenant.capacity - 1};t=1`,
    );
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('Retry-After is at least 1 second', async () => {
    limiter.retryAfterMs = 0;
    try {
      for (let i = 0; i < POLICIES.qa.user.capacity; i++) {
        await call('post', '/probe/ask', token('viewer'));
      }
      const res = await call('post', '/probe/ask', token('viewer')).expect(429);
      expect(res.headers['retry-after']).toBe('1');
    } finally {
      limiter.retryAfterMs = 4_200;
    }
  });

  it('keys the buckets on the verified user, tenant and class', async () => {
    await call('post', '/probe/ask', token('viewer', BOB, 'globex')).expect(201);
    expect(limiter.calls).toEqual([
      {
        userKey: `rl:v1:{${GLOBEX_ID}}:u:${BOB}:qa`,
        tenantKey: `rl:v1:{${GLOBEX_ID}}:t:qa`,
        user: POLICIES.qa.user,
        tenant: POLICIES.qa.tenant,
      },
    ]);
  });

  it('one user out of tokens does not stop another user, or another tenant', async () => {
    for (let i = 0; i < POLICIES.qa.user.capacity; i++) {
      await call('post', '/probe/ask', token('viewer', ALICE)).expect(201);
    }
    await call('post', '/probe/ask', token('viewer', ALICE)).expect(429);
    await call('post', '/probe/ask', token('viewer', BOB)).expect(201);
    await call('post', '/probe/ask', token('viewer', ALICE, 'globex')).expect(201);
  });

  it('the tenant bucket caps all users of the tenant together', async () => {
    const tenantCapacity = POLICIES.qa.tenant.capacity;
    const users = Array.from(
      { length: tenantCapacity },
      (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
    );
    for (const user of users) {
      await call('post', '/probe/ask', token('viewer', user)).expect(201);
    }
    // A fresh user with a full bucket of their own is still refused: the tenant has none left.
    await call('post', '/probe/ask', token('viewer', BOB)).expect(429);
    await call('post', '/probe/ask', token('viewer', BOB, 'globex')).expect(201);
  });

  it('classes have separate buckets: reads still work after the qa bucket is empty', async () => {
    for (let i = 0; i < POLICIES.qa.user.capacity; i++) {
      await call('post', '/probe/ask', token('viewer'));
    }
    await call('post', '/probe/ask', token('viewer')).expect(429);
    await call('get', '/probe/read', token('viewer')).expect(200);
  });

  it('without @RateLimit, GET is read and POST is write; @RateLimit overrides the method', async () => {
    await call('get', '/probe/read', token('accountant')).expect(200);
    await call('post', '/probe/write', token('accountant')).expect(201);
    await call('get', '/probe/upload-class', token('accountant')).expect(200);
    expect(limiter.calls.map((c) => c.userKey.split(':').pop())).toEqual([
      'read',
      'write',
      'upload',
    ]);
  });

  it('a refused caller spends no token: 401 and 403 happen before the limiter', async () => {
    await call('post', '/probe/ask').expect(401);
    await call('post', '/probe/write', token('viewer')).expect(403);
    expect(limiter.calls).toHaveLength(0);
  });

  it('public routes are not limited', async () => {
    await call('get', '/probe/open').expect(200);
    expect(limiter.calls).toHaveLength(0);
  });

  describe('Redis down', () => {
    beforeEach(() => {
      limiter.down = true;
    });

    it('read and write classes fail open: the request goes on', async () => {
      await call('get', '/probe/read', token('accountant')).expect(200);
      await call('post', '/probe/write', token('accountant')).expect(201);
    });

    it('qa and upload classes fail closed: 503 RATE_LIMIT_UNAVAILABLE', async () => {
      const qa = await call('post', '/probe/ask', token('viewer')).expect(503);
      expect(qa.body).toMatchObject({ status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
      await call('get', '/probe/upload-class', token('viewer')).expect(503);
    });
  });
});
