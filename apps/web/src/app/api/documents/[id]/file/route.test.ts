import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const state = { token: 'tok' as string | null };
vi.mock('@/auth/session', () => ({
  getAccessToken: () => Promise.resolve(state.token),
  getSession: () => Promise.resolve({ tenants: ['acme', 'globex'] }),
}));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => ({ value: 'globex' }) }),
}));

import { GET } from './route';

const ID = '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11';
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv('API_BASE_URL', 'http://api.test');
  state.token = 'tok';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response('%PDF-1.7 bytes', {
        headers: { 'content-type': 'application/pdf', 'x-leaky': 'upstream-only' },
      }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const get = (id: string) =>
  GET(new NextRequest(`http://localhost:3000/api/documents/${id}/file`), {
    params: Promise.resolve({ id }),
  });

describe('GET /api/documents/[id]/file', () => {
  it('streams the bytes with the bearer token and tenant, and sets inert headers itself', async () => {
    const res = await get(ID);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7 bytes');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-leaky')).toBeNull(); // upstream headers are not copied wholesale
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(`http://api.test/documents/${ID}/file`);
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok', 'x-tenant': 'globex' });
  });

  it('turns a content type it does not know into opaque bytes (never html)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<script>', { headers: { 'content-type': 'text/html' } }),
    );
    expect((await get(ID)).headers.get('content-type')).toBe('application/octet-stream');
  });

  it('never forwards an id that is not a uuid, and answers 401 without a token', async () => {
    expect((await get('..%2Fx')).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    state.token = null;
    expect((await get(ID)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes on 404 with our code and hides every other failure behind 502', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'X' }, { status: 404 }));
    expect((await get(ID)).status).toBe(404);
    fetchMock.mockResolvedValueOnce(Response.json({ detail: 'secret' }, { status: 500 }));
    const broken = await get(ID);
    expect(broken.status).toBe(502);
    expect(JSON.stringify(await broken.json())).not.toContain('secret');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await get(ID)).status).toBe(502);
  });
});
