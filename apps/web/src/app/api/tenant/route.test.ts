import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const secret = 'x'.repeat(40);

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
  vi.stubEnv('NEXTAUTH_SECRET', secret);
  vi.stubEnv('KEYCLOAK_ISSUER', 'http://kc/realms/invoice');
  vi.stubEnv('KEYCLOAK_CLIENT_ID', 'web');
  vi.stubEnv('KEYCLOAK_CLIENT_SECRET', 'cs');
});
afterEach(() => vi.unstubAllEnvs());

async function post(
  fields: Record<string, string>,
  opts: { origin?: string | null; tenants?: string[] | null } = {},
) {
  const { origin = 'http://localhost:3000', tenants = ['acme', 'globex'] } = opts;
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  if (tenants) {
    headers.cookie = `next-auth.session-token=${await encode({ secret, token: { tenants } })}`;
  }
  return POST(
    new NextRequest('http://localhost:3000/api/tenant', {
      method: 'POST',
      headers,
      body: new URLSearchParams(fields),
    }),
  );
}

describe('POST /api/tenant', () => {
  it('stores a tenant from the signed token in an httpOnly cookie and goes back', async () => {
    const res = await post({ tenant: 'globex', returnTo: '/en/dashboard' });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/en/dashboard');
    const cookie = res.cookies.get('tenant');
    expect(cookie).toMatchObject({ value: 'globex', httpOnly: true, sameSite: 'lax' });
  });

  it.each([
    ['a tenant the user does not belong to', { tenant: 'initech' }, {}],
    ['a malformed alias', { tenant: 'acme organization:*' }, {}],
    ['no tenant field', {}, {}],
    ['a foreign origin', { tenant: 'acme' }, { origin: 'http://evil.example' }],
    ['no origin', { tenant: 'acme' }, { origin: null }],
    ['no session', { tenant: 'acme' }, { tenants: null }],
    ['a session with no tenants', { tenant: 'acme' }, { tenants: [] }],
  ])('refuses %s with 403 and sets no cookie', async (_name, fields, opts) => {
    const res = await post(fields, opts);
    expect(res.status).toBe(403);
    expect(res.cookies.get('tenant')).toBeUndefined();
  });

  it.each(['//evil.example', 'https://evil.example', undefined])(
    'never redirects off-site (returnTo %s)',
    async (returnTo) => {
      const res = await post(returnTo ? { tenant: 'acme', returnTo } : { tenant: 'acme' });
      expect(new URL(res.headers.get('location')!).origin).toBe('http://localhost:3000');
    },
  );
});
