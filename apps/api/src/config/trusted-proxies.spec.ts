import { Controller, Get, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { AddressInfo } from 'node:net';
import { validateEnv } from './env.schema';
import { auditIp, trustedProxiesProblem } from './trusted-proxies';

const BASE = {
  NODE_ENV: 'test',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/invoice',
  DATABASE_URL: 'postgres://invoice_app:pw@localhost:5433/invoice',
  DATA_DIR: '/var/lib/invoice-data',
  REDIS_URL: 'redis://localhost:6380',
  AI_SERVICE_URL: 'http://localhost:8000',
  AI_SERVICE_TOKEN: 'x'.repeat(16),
};

describe('TRUSTED_PROXIES validation', () => {
  it.each(['loopback', 'loopback, 10.0.0.0/8', '172.18.0.2', 'uniquelocal,::1', 'fd00::/8'])(
    'accepts %s',
    (value) => {
      expect(trustedProxiesProblem(value)).toBeNull();
      expect(validateEnv({ ...BASE, TRUSTED_PROXIES: value }).TRUSTED_PROXIES).toBe(value);
    },
  );

  it.each([
    'true',
    '1',
    ' ',
    'loopback,',
    '0.0.0.0/0',
    '::/0',
    '10.0.0.0/33',
    'nonsense',
    '1.2.3/8',
  ])('refuses %j (it would trust everyone or is not an address)', (value) => {
    expect(trustedProxiesProblem(value)).not.toBeNull();
    expect(() => validateEnv({ ...BASE, TRUSTED_PROXIES: value })).toThrow(/TRUSTED_PROXIES/);
  });
});

describe('empty TRUSTED_PROXIES', () => {
  it('counts as not set: a copied `TRUSTED_PROXIES=` line must not stop the API', () => {
    expect(validateEnv({ ...BASE, TRUSTED_PROXIES: '' }).TRUSTED_PROXIES).toBe('loopback');
  });
});

describe('auditIp', () => {
  it.each(['203.0.113.7', '::1', '2001:db8::1', '::ffff:127.0.0.1'])('keeps %s', (ip) => {
    expect(auditIp(ip)).toBe(ip);
  });
  it.each(['garbage', '999.1.1.1', '', '1.2.3.4; select 1', undefined])(
    'drops %j instead of failing the upload',
    (ip) => {
      expect(auditIp(ip)).toBeUndefined();
    },
  );
});

@Controller()
class WhoAmIController {
  @Get()
  who(@Req() req: Request): { ip: string | undefined } {
    return { ip: req.ip };
  }
}

/** Starts a real Nest/Express server and returns the address it reports for this XFF header. */
async function addressSeen(trusted: string, forwardedFor: string): Promise<string | undefined> {
  const moduleRef = await Test.createTestingModule({ controllers: [WhoAmIController] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', trusted);
  await app.listen(0, '127.0.0.1');
  try {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'x-forwarded-for': forwardedFor },
    });
    return ((await res.json()) as { ip?: string }).ip;
  } finally {
    await app.close();
  }
}

describe('what req.ip becomes with TRUSTED_PROXIES', () => {
  it('a trusted peer (here: loopback) is believed: the caller address comes from X-Forwarded-For', async () => {
    expect(await addressSeen('loopback', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('a peer that is not trusted cannot choose the address: X-Forwarded-For is ignored', async () => {
    const ip = await addressSeen('198.51.100.0/24', '203.0.113.7');
    expect(ip).toMatch(/127\.0\.0\.1$/);
  });
});
