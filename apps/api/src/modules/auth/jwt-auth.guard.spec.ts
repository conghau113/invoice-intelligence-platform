import type { INestApplication } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type JWTPayload, type KeyLike } from 'jose';
import request from 'supertest';
import { ProblemDetailsFilter } from '../../common/http/problem-details.filter';
import { APP_FILTER } from '@nestjs/core';
import { TENANT_DIRECTORY } from './application/tenant-directory.port';
import { TOKEN_VERIFIER } from './application/token-verifier.port';
import { AuthController } from './http/auth.controller';
import { CurrentTenant, type TenantContext } from './http/current-user.decorator';
import { JwtAuthGuard } from './http/jwt-auth.guard';
import { Public } from './http/public.decorator';
import { JoseTokenVerifier } from './infra/jose-token-verifier';

const ISSUER = 'http://idp.test/realms/invoice';
const AUDIENCE = 'api';
const ACME_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '11111111-1111-4111-8111-111111111111';

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }

  @Get('tenant')
  tenant(@CurrentTenant() t: TenantContext): TenantContext {
    return t;
  }
}

interface TestKey {
  kid: string;
  privateKey: KeyLike;
  jwk: JWK;
}

async function newKey(kid: string): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
  };
}

function sign(
  key: TestKey,
  claims: JWTPayload = {},
  opts: { iss?: string; aud?: string; exp?: string | number } = {},
): Promise<string> {
  return new SignJWT({ organization: ['acme'], realm_access: { roles: ['accountant'] }, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setSubject(USER_ID)
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(key.privateKey);
}

describe('JwtAuthGuard (real jose verifier against a local JWKS server)', () => {
  let app: INestApplication;
  let jwksServer: Server;
  let published: JWK[];
  let fetches: number;
  let keyA: TestKey;
  let keyB: TestKey;

  beforeAll(async () => {
    [keyA, keyB] = await Promise.all([newKey('key-a'), newKey('key-b')]);
    published = [keyA.jwk];
    fetches = 0;
    jwksServer = createServer((_req, res) => {
      fetches += 1;
      res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: published }));
    });
    await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));
    const jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/certs`;

    const mod = await Test.createTestingModule({
      controllers: [AuthController, ProbeController],
      providers: [
        {
          provide: TOKEN_VERIFIER,
          useValue: new JoseTokenVerifier({
            issuer: ISSUER,
            audience: AUDIENCE,
            jwksUrl,
            cooldownMs: 0,
          }),
        },
        {
          provide: TENANT_DIRECTORY,
          useValue: {
            idForAlias: (alias: string) => Promise.resolve(alias === 'acme' ? ACME_ID : undefined),
          },
        },
        { provide: ConfigService, useValue: {} },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await new Promise((r) => jwksServer.close(r));
  });

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('no token -> 401', async () => {
    await get('/auth/me').expect(401);
  });

  it('malformed Authorization header -> 401', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Basic abc')
      .expect(401);
    await get('/auth/me', 'not-a-jwt').expect(401);
  });

  it('wrong audience -> 401', async () => {
    await get('/auth/me', await sign(keyA, {}, { aud: 'other-api' })).expect(401);
  });

  it('wrong issuer -> 401', async () => {
    await get('/auth/me', await sign(keyA, {}, { iss: 'http://evil.test/realms/invoice' })).expect(
      401,
    );
  });

  it('expired token -> 401', async () => {
    await get('/auth/me', await sign(keyA, {}, { exp: Math.floor(Date.now() / 1000) - 60 })).expect(
      401,
    );
  });

  it('signature from a key not in the JWKS -> 401', async () => {
    const stranger = await newKey('key-a'); // same kid, different key material
    await get('/auth/me', await sign(stranger)).expect(401);
  });

  it('alg=none and HS256 tokens -> 401', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const payload = b64({
      sub: 'u',
      iss: ISSUER,
      aud: AUDIENCE,
      exp: 4_000_000_000,
      organization: ['acme'],
    });
    await get('/auth/me', `${b64({ alg: 'none', kid: 'key-a' })}.${payload}.`).expect(401);
    const hs = await new SignJWT({ organization: ['acme'] })
      .setProtectedHeader({ alg: 'HS256', kid: 'key-a' })
      .setSubject('u')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('x'.repeat(32)));
    await get('/auth/me', hs).expect(401);
  });

  it('valid token -> 200 with userId, tenantId and roles', async () => {
    const res = await get('/auth/me', await sign(keyA)).expect(200);
    expect(res.body).toEqual({ userId: USER_ID, tenantId: ACME_ID, roles: ['accountant'] });
  });

  it('@Public route needs no token', async () => {
    await get('/probe/open').expect(200);
  });

  it('tenant comes from the token; a spoofed tenant header is ignored', async () => {
    const res = await get('/probe/tenant', await sign(keyA))
      .set('X-Tenant-Id', '00000000-0000-4000-8000-0000000000a2')
      .set('X-Tenant', 'globex')
      .expect(200);
    expect(res.body).toEqual({ tenantId: ACME_ID, tenantAlias: 'acme' });
  });

  it('valid signature but no tenant / two tenants -> 403', async () => {
    await get('/auth/me', await sign(keyA, { organization: undefined })).expect(403);
    await get('/auth/me', await sign(keyA, { organization: ['acme', 'globex'] })).expect(403);
  });

  it('does not echo token content in the error body', async () => {
    const res = await get('/auth/me', await sign(keyA, {}, { aud: 'secret-aud-xyz' })).expect(401);
    expect(JSON.stringify(res.body)).not.toContain('secret-aud-xyz');
  });

  describe('key rotation', () => {
    it('caches the JWKS, picks up a new key on unknown kid, rejects a removed one', async () => {
      published = [keyA.jwk];
      await get('/auth/me', await sign(keyA)).expect(200);
      const before = fetches;
      await get('/auth/me', await sign(keyA)).expect(200);
      expect(fetches).toBe(before); // second request served from cache, no IdP call

      // Keycloak rotates: key-b is now published next to (then instead of) key-a.
      published = [keyA.jwk, keyB.jwk];
      await get('/auth/me', await sign(keyB)).expect(200); // unknown kid -> one refetch
      expect(fetches).toBeGreaterThan(before);

      published = [keyB.jwk];
      const unknown = await newKey('key-zzz');
      await get('/auth/me', await sign(unknown)).expect(401); // refetch, still unknown
    });
  });
});
