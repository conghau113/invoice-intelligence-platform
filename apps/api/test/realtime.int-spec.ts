/**
 * Realtime (T6.4, ADR 0014) against a real Redis in a container: TWO API instances, each a real
 * Nest app with the real AuthModule guards, the token route and the Socket.IO gateway behind the
 * Redis adapter, listening on its own port. The "worker" is a RedisEmitterPublisher with its own
 * connection and no Socket.IO server, as in the worker process.
 *
 * - An event published by the worker reaches clients on BOTH instances (the Redis adapter), and a
 *   token issued by one instance opens a socket on the other (shared key).
 * - Rooms: another tenant's client, and another user's room, get nothing.
 * - Refused handshakes: no token, a forged or expired one, a Keycloak-like token, a foreign origin.
 * - A socket is closed by the server after its maximum age.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DOCUMENT_UPDATED, REALTIME_PATH, type DocumentUpdatedEvent } from 'contracts';
import { SignJWT } from 'jose';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { StartedTestContainer } from 'testcontainers';
import { TENANT_DIRECTORY } from '../src/modules/auth/application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../src/modules/auth/application/token-verifier.port';
import { AuthModule } from '../src/modules/auth/auth.module';
import { producerConnection } from '../src/modules/queue/infra/redis-connection';
import { RedisEmitterPublisher } from '../src/modules/realtime/infra/redis-emitter-publisher';
import { useRealtimeAdapter } from '../src/modules/realtime/infra/realtime-io.adapter';
import { RealtimeModule } from '../src/modules/realtime/realtime.module';
import { startRedis } from './support/reachable-container';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-0000000000b0';
const DOC = '00000000-0000-4000-8000-00000000d0c1';
const SECRET = 'realtime-int-test-secret-0123456789abcdef';
const WEB = 'http://localhost:3000';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROBE = 'probe';
const event = (status: string): DocumentUpdatedEvent => ({ id: DOC, status, version: 1 });

describe('realtime (Socket.IO, Redis adapter, two API instances)', () => {
  let redis: StartedTestContainer;
  let redisUrl: string;
  let instances: { app: INestApplication; url: string }[];
  let worker: RedisEmitterPublisher;
  const sockets: Socket[] = [];

  async function startInstance(values: Record<string, unknown>) {
    @Global()
    @Module({
      providers: [{ provide: ConfigService, useValue: { get: (k: string) => values[k] } }],
      exports: [ConfigService],
    })
    class FakeConfigModule {}

    const mod = await Test.createTestingModule({
      imports: [FakeConfigModule, AuthModule, RealtimeModule],
    })
      // Bearer "<role>:<sub>:<alias>" is that user in that tenant (the JWKS check is not under test).
      .overrideProvider(TOKEN_VERIFIER)
      .useValue({
        verify: (token: string) => {
          const [role, sub, org] = token.split(':');
          return Promise.resolve({ sub, organization: [org], realm_access: { roles: [role] } });
        },
      })
      .overrideProvider(TENANT_DIRECTORY)
      .useValue({ idForAlias: (a: string) => Promise.resolve({ acme: ACME, globex: GLOBEX }[a]) })
      .compile();
    const app = mod.createNestApplication();
    useRealtimeAdapter(app);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    return { app, url: `http://127.0.0.1:${port}` };
  }

  const baseEnv = () => ({
    NODE_ENV: 'test',
    DEMO_READ_ONLY: false,
    REDIS_URL: redisUrl,
    REALTIME_TOKEN_SECRET: SECRET,
    REALTIME_ALLOWED_ORIGINS: [WEB],
    REALTIME_MAX_CONNECTION_MS: 900_000,
  });

  beforeAll(async () => {
    redis = await startRedis();
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    instances = [await startInstance(baseEnv()), await startInstance(baseEnv())];
    worker = new RedisEmitterPublisher(producerConnection(redisUrl));
  }, 120_000);

  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    for (const { app } of instances ?? []) await app.close();
    worker?.onApplicationShutdown();
    await redis?.stop();
  });

  const at = (i: number) => {
    const instance = instances[i];
    if (instance === undefined) throw new Error(`no instance ${i}`);
    return instance;
  };

  /** What the web server does: ask an instance for a handshake token, as the signed-in user. */
  async function tokenFor(bearer: string, alias: string, i = 0): Promise<string> {
    const res = await request(at(i).app.getHttpServer())
      .post('/realtime/token')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Tenant', alias)
      .expect(200);
    expect(res.body).toEqual({ token: expect.any(String), expiresIn: 60 });
    return res.body.token as string;
  }

  /** Opens a socket like the browser does (WebSocket only, the web's Origin). */
  function connect(i: number, token: unknown, origin = WEB): Socket {
    const socket = io(`${at(i).url}/realtime`, {
      path: REALTIME_PATH,
      transports: ['websocket'],
      auth: token === undefined ? {} : { token },
      extraHeaders: { origin },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  }

  /** It may have connected already, while the test was awaiting something else. */
  const connected = (s: Socket) =>
    new Promise<void>((resolve, reject) => {
      if (s.connected) {
        resolve();
        return;
      }
      s.once('connect', () => resolve());
      s.once('connect_error', (e) => reject(e));
    });

  /** Resolves with the error message the handshake was refused with. */
  const refused = (s: Socket) =>
    new Promise<string>((resolve, reject) => {
      s.once('connect', () => reject(new Error('the handshake was accepted')));
      s.once('connect_error', (e) => resolve(e.message));
    });

  /** Events a socket receives from now on, without the probes of `roomsReady` still in flight. */
  function collect(s: Socket): DocumentUpdatedEvent[] {
    const seen: DocumentUpdatedEvent[] = [];
    s.on(DOCUMENT_UPDATED, (e: DocumentUpdatedEvent) => {
      if (e.status !== PROBE) seen.push(e);
    });
    return seen;
  }

  async function until(check: () => boolean, ms = 5_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await sleep(20);
    }
  }

  /**
   * The adapter subscribes asynchronously after a socket joins; publishing before that would lose
   * the event. Wait until a probe published now arrives on every listed socket.
   */
  async function roomsReady(tenantId: string, ...on: Socket[]): Promise<void> {
    const got = on.map(() => false);
    const handlers = on.map((s, n) => {
      const h = (e: DocumentUpdatedEvent) => {
        if (e.status === PROBE) got[n] = true;
      };
      s.on(DOCUMENT_UPDATED, h);
      return h;
    });
    await until(() => {
      worker.toTenant(tenantId, { name: DOCUMENT_UPDATED, payload: event(PROBE) });
      return got.every(Boolean);
    });
    on.forEach((s, n) => s.off(DOCUMENT_UPDATED, handlers[n]));
  }

  it('an event published by the worker reaches clients on BOTH instances', async () => {
    // Token from instance 0, socket on instance 1: the key is shared, any instance takes any socket.
    const a0 = connect(0, await tokenFor(`accountant:${ALICE}:acme`, 'acme', 0));
    const a1 = connect(1, await tokenFor(`viewer:${BOB}:acme`, 'acme', 0));
    await Promise.all([connected(a0), connected(a1)]);
    await roomsReady(ACME, a0, a1);
    const seen0 = collect(a0);
    const seen1 = collect(a1);

    worker.toTenant(ACME, { name: DOCUMENT_UPDATED, payload: event('needs_review') });

    await until(() => seen0.length === 1 && seen1.length === 1);
    expect(seen0).toEqual([event('needs_review')]);
    expect(seen1).toEqual([event('needs_review')]);
  });

  it("another tenant's client gets nothing, and a user room reaches only that user", async () => {
    const alice = connect(0, await tokenFor(`accountant:${ALICE}:acme`, 'acme'));
    const bob = connect(1, await tokenFor(`accountant:${BOB}:acme`, 'acme'));
    const globex = connect(1, await tokenFor(`accountant:${ALICE}:globex`, 'globex'));
    await Promise.all([connected(alice), connected(bob), connected(globex)]);
    await roomsReady(ACME, alice, bob);
    await roomsReady(GLOBEX, globex);
    const [seenAlice, seenBob, seenGlobex] = [collect(alice), collect(bob), collect(globex)];

    worker.toTenant(ACME, { name: DOCUMENT_UPDATED, payload: event('approved') });
    worker.toUser(ACME, ALICE, { name: DOCUMENT_UPDATED, payload: event('failed') });
    // A marker after both: once Globex has it, the two events before it would have arrived too.
    worker.toTenant(GLOBEX, { name: DOCUMENT_UPDATED, payload: event('queued') });

    await until(() => seenAlice.length === 2 && seenBob.length === 1 && seenGlobex.length === 1);
    await sleep(200);
    expect(seenAlice).toEqual([event('approved'), event('failed')]);
    expect(seenBob).toEqual([event('approved')]);
    // Alice is in Globex too, but this socket is for Globex: no Acme event, not even her own.
    expect(seenGlobex).toEqual([event('queued')]);
  });

  it('a payload with extra fields is never sent', async () => {
    const s = connect(0, await tokenFor(`accountant:${ALICE}:acme`, 'acme'));
    await connected(s);
    await roomsReady(ACME, s);
    const seen = collect(s);

    const leaky = { ...event('approved'), sellerName: 'SAMPLE CO' } as DocumentUpdatedEvent;
    worker.toTenant(ACME, { name: DOCUMENT_UPDATED, payload: leaky });
    worker.toTenant(ACME, { name: DOCUMENT_UPDATED, payload: event('queued') });

    await until(() => seen.length === 1);
    expect(seen).toEqual([event('queued')]);
  });

  it.each([
    ['no token', undefined],
    ['a token that is not a string', 42],
    ['a garbage token', 'not-a-jwt'],
    [
      'a bearer token of the REST API (wrong issuer, audience, algorithm)',
      `accountant:${ALICE}:acme`,
    ],
  ])('refuses a handshake with %s', async (_name, token) => {
    expect(await refused(connect(0, token))).toBe('UNAUTHORIZED');
  });

  it('refuses a token signed with another key, an expired one and one for another audience', async () => {
    const sign = (key: string, aud: string, exp: number) =>
      new SignJWT({ tid: ACME })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(ALICE)
        .setIssuer('invoice-api')
        .setAudience(aud)
        .setExpirationTime(exp)
        .sign(new TextEncoder().encode(key));
    const now = Math.floor(Date.now() / 1000);

    for (const token of [
      await sign('another-key-another-key-another-key!', 'realtime', now + 60),
      await sign(SECRET, 'realtime', now - 60),
      await sign(SECRET, 'api', now + 60),
    ]) {
      expect(await refused(connect(1, token))).toBe('UNAUTHORIZED');
    }
    // The same claims, rightly signed, pass: the refusals above are about key, expiry and audience.
    await connected(connect(1, await sign(SECRET, 'realtime', now + 60)));
  });

  it('refuses a foreign or missing Origin before any token check', async () => {
    const token = await tokenFor(`accountant:${ALICE}:acme`, 'acme');
    const evil = await refused(connect(0, token, 'https://evil.example.test'));
    expect(evil).not.toBe('UNAUTHORIZED'); // refused at the HTTP upgrade, not by the middleware
    expect(await refused(connect(0, token, ''))).not.toBe('UNAUTHORIZED');
  });

  it('refuses the root namespace, which serves nothing, even with a valid token', async () => {
    const token = await tokenFor(`accountant:${ALICE}:acme`, 'acme');
    const root = io(at(0).url, {
      path: REALTIME_PATH,
      transports: ['websocket'],
      auth: { token },
      extraHeaders: { origin: WEB },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(root);
    expect(await refused(root)).toBe('UNAUTHORIZED');
  });

  it('the token route needs a signed-in member of the tenant', async () => {
    await request(at(0).app.getHttpServer()).post('/realtime/token').expect(401);
    await request(at(0).app.getHttpServer())
      .post('/realtime/token')
      .set('Authorization', `Bearer accountant:${ALICE}:acme`)
      .set('X-Tenant', 'globex')
      .expect(403);
  });

  it('closes a socket after its maximum age, so the client must come back with a new token', async () => {
    const short = await startInstance({ ...baseEnv(), REALTIME_MAX_CONNECTION_MS: 1_000 });
    instances.push(short);
    const s = connect(instances.length - 1, await tokenFor(`accountant:${ALICE}:acme`, 'acme'));
    await connected(s);
    const started = Date.now();

    const reason = await new Promise<string>((resolve) => s.once('disconnect', resolve));

    expect(reason).toBe('io server disconnect');
    const lived = Date.now() - started;
    expect(lived).toBeGreaterThanOrEqual(850); // up to 10% jitter below 1 000 ms
    expect(lived).toBeLessThan(2_000);
  });

  it('with realtime off (no secret) the token route answers 404 and every handshake is refused', async () => {
    const off = await startInstance({ ...baseEnv(), REALTIME_TOKEN_SECRET: undefined });
    instances.push(off);
    const i = instances.length - 1;
    await request(off.app.getHttpServer())
      .post('/realtime/token')
      .set('Authorization', `Bearer accountant:${ALICE}:acme`)
      .set('X-Tenant', 'acme')
      .expect(404);
    // Even a token that another (enabled) instance issued.
    expect(await refused(connect(i, await tokenFor(`accountant:${ALICE}:acme`, 'acme')))).toBe(
      'UNAUTHORIZED',
    );
  });
});
