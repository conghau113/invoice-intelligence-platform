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

const ID = '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11';
const TRACE = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv('API_BASE_URL', 'http://api.test');
  state.token = 'tok';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(Response.json({ id: ID })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const get = (id: string, headers: Record<string, string> = {}) =>
  GET(new NextRequest(`http://localhost:3000/api/documents/${id}`, { headers }), {
    params: Promise.resolve({ id }),
  });

describe('GET /api/documents/[id]', () => {
  it('calls the API with the bearer token, tenant and a valid traceparent, and returns the body', async () => {
    const res = await get(ID, { traceparent: TRACE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(`http://api.test/documents/${ID}`);
    expect(init.headers).toMatchObject({
      authorization: 'Bearer tok',
      'x-tenant': 'globex',
      traceparent: TRACE,
    });
  });

  it('drops a malformed traceparent', async () => {
    await get(ID, { traceparent: 'garbage' });
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers.traceparent).toBeUndefined();
  });

  it('never forwards an id that is not a uuid (no path tricks), and does not call the API', async () => {
    for (const bad of ['..%2Fadmin%2Fjobs', '1/../../x', 'abc', `${ID}/file`]) {
      const res = await get(decodeURIComponent(bad));
      expect(res.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 without a token and calls nothing', async () => {
    state.token = null;
    expect((await get(ID)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes on 401/403/404 with our own code and turns every other failure into 502', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'TENANT_NOT_MEMBER' }, { status: 403 }));
    const forbidden = await get(ID);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ code: 'TENANT_NOT_MEMBER' });

    fetchMock.mockResolvedValueOnce(
      Response.json({ detail: 'Document not found' }, { status: 404 }),
    );
    expect((await get(ID)).status).toBe(404);

    fetchMock.mockResolvedValueOnce(
      Response.json(
        { detail: 'secret internals', code: 'EXTRACTION_DATA_INVALID' },
        { status: 500 },
      ),
    );
    const broken = await get(ID);
    expect(broken.status).toBe(502);
    expect(JSON.stringify(await broken.json())).not.toContain('secret');

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const down = await get(ID);
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ code: 'API_UNREACHABLE' });
  });
});
