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

const post = async (origin: string | null) => {
  const jwt = await encode({ secret, token: { idToken: 'IDT' } });
  const headers: Record<string, string> = { cookie: `next-auth.session-token=${jwt}` };
  if (origin) headers.origin = origin;
  return POST(
    new NextRequest('http://localhost:3000/api/auth/logout', { method: 'POST', headers }),
  );
};

describe('POST /api/auth/logout', () => {
  it.each(['http://evil.example', null])(
    'rejects origin %s with 403 and keeps the cookie',
    async (o) => {
      const res = await post(o);
      expect(res.status).toBe(403);
      expect(res.cookies.get('next-auth.session-token')).toBeUndefined();
    },
  );

  it('redirects to Keycloak end_session with id_token_hint and clears the session cookie', async () => {
    const res = await post('http://localhost:3000');
    expect(res.status).toBe(303);
    const u = new URL(res.headers.get('location')!);
    expect(u.pathname).toBe('/realms/invoice/protocol/openid-connect/logout');
    expect(u.searchParams.get('id_token_hint')).toBe('IDT');
    expect(res.cookies.get('next-auth.session-token')?.value).toBe('');
  });
});
