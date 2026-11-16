import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const state = { token: 'tok' as string | null, tenants: ['acme', 'globex'], cookie: 'globex' };
vi.mock('@/auth/session', () => ({
  getAccessToken: () => Promise.resolve(state.token),
  getSession: () => Promise.resolve({ tenants: state.tenants }),
}));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => ({ value: state.cookie }) }),
}));
vi.mock('@/auth/env', () => ({ authEnv: () => ({ NEXTAUTH_URL: 'http://localhost:3000' }) }));

import { POST } from './route';
import { expectRateLimitedPassedOn, rateLimitedUpstream } from '@/lib/testing/rate-limited';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv('API_BASE_URL', 'http://api.test');
  vi.stubEnv('REALTIME_PUBLIC_URL', 'http://localhost:3001');
  state.token = 'tok';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(Response.json({ token: 'rt', expiresIn: 60 })),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const post = (origin: string | null = 'http://localhost:3000') =>
  POST(
    new NextRequest('http://localhost:3000/api/realtime/token', {
      method: 'POST',
      headers: origin === null ? {} : { origin },
    }),
  );

describe('POST /api/realtime/token', () => {
  it("asks the API with the user's token and tenant, and hands the browser only the socket token", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ token: 'rt', expiresIn: 60, url: 'http://localhost:3001' });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('http://api.test/realtime/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok', 'x-tenant': 'globex' });
  });

  it('refuses a cross-site or origin-less request before calling anything', async () => {
    expect((await post('https://evil.example.test')).status).toBe(403);
    expect((await post(null)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['localhost:3001', 'http://localhost:3001/path', 'ws://localhost:3001'])(
    'answers 404 (realtime off) when REALTIME_PUBLIC_URL is %s',
    async (value) => {
      vi.stubEnv('REALTIME_PUBLIC_URL', value);
      expect((await post()).status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('defaults to the local API outside production, and is off in production when not set', async () => {
    vi.stubEnv('REALTIME_PUBLIC_URL', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(await (await post()).json()).toMatchObject({ url: 'http://localhost:3001' });
    vi.stubEnv('NODE_ENV', 'production');
    fetchMock.mockClear();
    expect((await post()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 without a session, calling nothing', async () => {
    state.token = null;
    expect((await post()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [404, 404],
    [401, 401],
    [403, 403],
    [500, 502],
  ])('maps an API %i to %i without passing the body on', async (upstream, status) => {
    fetchMock.mockResolvedValue(
      Response.json({ code: 'X', detail: 'secret' }, { status: upstream }),
    );
    const res = await post();
    expect(res.status).toBe(status);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });

  it('refuses a malformed API answer and an unreachable API', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ token: 'rt', expiresIn: 60, extra: 1 }));
    expect((await post()).status).toBe(502);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await post()).status).toBe(502);
  });

  it('passes a 429 on with its Retry-After', async () => {
    fetchMock.mockResolvedValue(rateLimitedUpstream());
    await expectRateLimitedPassedOn(await post());
  });
});
