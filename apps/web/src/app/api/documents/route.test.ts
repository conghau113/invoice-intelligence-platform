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

import { GET } from './route';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv('API_BASE_URL', 'http://api.test');
  state.token = 'tok';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      Response.json({ items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const get = (qs = '') => GET(new NextRequest(`http://localhost:3000/api/documents${qs}`));

describe('GET /api/documents', () => {
  it('calls the API with the bearer token and the chosen tenant, and returns its page', async () => {
    const res = await get('?status=failed');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://api.test/documents?status=failed&limit=20');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok', 'x-tenant': 'globex' });
  });

  it('forwards only known, valid parameters, rebuilt from the parsed values', async () => {
    await get(
      '?status=nope&tenant=other&limit=100000&type=pdf&cursor=a%20b&sort=-createdAt&page=-1',
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test/documents?type=pdf&limit=20');
  });

  it('passes the page and the page size on as page and limit', async () => {
    await get('?page=3&limit=50');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test/documents?page=3&limit=50');
    await get('?limit=33'); // not a size the screen offers: the default
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://api.test/documents?limit=20');
  });

  it('relays a well-formed traceparent and drops anything else', async () => {
    const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await GET(
      new NextRequest('http://localhost:3000/api/documents', { headers: { traceparent: tp } }),
    );
    await GET(
      new NextRequest('http://localhost:3000/api/documents', {
        headers: { traceparent: 'not-a-traceparent' },
      }),
    );
    const sent = fetchMock.mock.calls.map(
      (c) => (c[1] as { headers: Record<string, string> }).headers,
    );
    expect(sent[0]?.traceparent).toBe(tp);
    expect(sent[1]?.traceparent).toBeUndefined();
  });

  it('answers 401 without calling the API when there is no token', async () => {
    state.token = null;
    expect((await get()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a 403 on with its code', async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'TENANT_NOT_MEMBER' }, { status: 403 }));
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'TENANT_NOT_MEMBER' });
  });

  it('tells "API down" apart from "API error", and never relays the upstream body', async () => {
    fetchMock.mockRejectedValue(new TypeError('ECONNREFUSED'));
    const down = await get();
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ code: 'API_UNREACHABLE' });

    fetchMock.mockResolvedValue(
      Response.json({ detail: 'secret internals', code: 'X' }, { status: 500 }),
    );
    const err = await get();
    expect(err.status).toBe(502);
    expect(await err.json()).toEqual({ code: 'API_ERROR' });
  });
});
