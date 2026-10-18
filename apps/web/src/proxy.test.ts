import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkCookie } from '@/auth/cookie';
import proxy from './proxy';

const secret = 'x'.repeat(40);
const NAME = 'next-auth.session-token';
const now = () => Math.floor(Date.now() / 1000);
let n = 0;
const big = () => randomBytes(4500).toString('base64url'); // incompressible: forces >1 cookie chunk

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
  vi.stubEnv('NEXTAUTH_SECRET', secret);
  vi.stubEnv('KEYCLOAK_ISSUER', 'http://kc/realms/invoice');
  vi.stubEnv('KEYCLOAK_CLIENT_ID', 'web');
  vi.stubEnv('KEYCLOAK_CLIENT_SECRET', 'cs');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function reqWith(expiresAt: number, opts: { padding?: string; path?: string } = {}) {
  const jwt = await encode({
    secret,
    token: { accessToken: opts.padding ?? 'a1', refreshToken: `r-${n++}`, expiresAt },
  });
  const cookie = Object.entries(chunkCookie(NAME, jwt))
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return new NextRequest(`http://localhost:3000${opts.path ?? '/dashboard'}`, {
    headers: { cookie },
  });
}
const refreshOk = (access = 'a2') =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ access_token: access, refresh_token: 'r2', expires_in: 300 }),
    ),
  );

describe('proxy', () => {
  it('redirects signed-out users to /login', async () => {
    const res = await proxy(new NextRequest('http://localhost:3000/dashboard'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, 'http://localhost:3000').pathname).toBe('/login');
  });

  it('serves public paths even when the auth environment is missing', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('NEXTAUTH_SECRET', '');
    const res = await proxy(new NextRequest('http://localhost:3000/api/health'));
    expect(res.status).toBe(200);
  });

  it('lets a fresh session through without calling Keycloak', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await proxy(await reqWith(now() + 300));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token and re-issues the cookie (user stays signed in)', async () => {
    refreshOk();
    const res = await proxy(await reqWith(now() - 10));
    expect(res.status).toBe(200);
    const set = res.cookies.get(NAME);
    expect(set?.value).toBeTruthy();
    expect(set?.httpOnly).toBe(true);
    expect(set?.sameSite).toBe('lax');
    // The page rendered next must see the NEW cookie, not the expired one.
    expect(res.headers.get('x-middleware-request-cookie')).toBe(`${NAME}=${set!.value}`);
  });

  it('drops stale chunks when the new cookie needs fewer chunks', async () => {
    refreshOk();
    const res = await proxy(await reqWith(now() - 10, { padding: big() }));
    expect(res.cookies.get(`${NAME}.0`)?.value).toBe('');
    expect(res.cookies.get(`${NAME}.1`)?.value).toBe('');
    expect(res.cookies.get(NAME)?.value).toBeTruthy();
    expect(res.headers.get('x-middleware-request-cookie')).toBe(
      `${NAME}=${res.cookies.get(NAME)!.value}`,
    );
  });

  it('writes several chunks when the new cookie is large, and forwards them all', async () => {
    refreshOk(big());
    const res = await proxy(await reqWith(now() - 10));
    const chunks = res.cookies.getAll().filter((c) => c.name.startsWith(`${NAME}.`));
    expect(chunks.length).toBeGreaterThan(1);
    const forwarded = chunks.map((c) => `${c.name}=${c.value}`).join('; ');
    expect(res.headers.get('x-middleware-request-cookie') === forwarded).toBe(true);
  });

  it('sends the user to /login and clears the cookie when Keycloak rejects the refresh token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })),
    );
    const res = await proxy(await reqWith(now() - 10));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, 'http://localhost:3000').pathname).toBe('/login');
    expect(res.cookies.get(NAME)?.value).toBe('');
  });

  it('keeps the session when Keycloak is down (no logout on a transient failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 503 })),
    );
    const res = await proxy(await reqWith(now() - 10));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.cookies.get(NAME)).toBeUndefined();
  });

  it('marks cookies Secure and uses the __Secure- name on https', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://app.example');
    refreshOk();
    const jwt = await encode({
      secret,
      token: { accessToken: 'a', refreshToken: `r-${n++}`, expiresAt: now() - 10 },
    });
    const res = await proxy(
      new NextRequest('https://app.example/dashboard', {
        headers: { cookie: `__Secure-${NAME}=${jwt}` },
      }),
    );
    expect(res.cookies.get(`__Secure-${NAME}`)?.secure).toBe(true);
  });
});
