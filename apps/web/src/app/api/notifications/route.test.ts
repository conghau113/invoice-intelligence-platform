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
vi.mock('@/auth/env', () => ({
  authEnv: () => ({ NEXTAUTH_URL: 'http://localhost:3000' }),
}));

import { GET } from './route';
import { POST as readOne } from './[id]/read/route';
import { POST as readAll } from './read-all/route';
import { expectRateLimitedPassedOn, rateLimitedUpstream } from '@/lib/testing/rate-limited';

const ORIGIN = 'http://localhost:3000';
const ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const PAGE = {
  items: [
    {
      id: ID,
      kind: 'extraction_failed',
      documentId: '0b6f6c1e-8f4b-4c55-9f0e-6f1d8a1b2c3d',
      failureCode: 'PDF_INVALID',
      createdAt: '2026-11-16T03:04:05.678Z',
      readAt: null,
    },
  ],
  meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
  unreadCount: 1,
};
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv('API_BASE_URL', 'http://api.test');
  state.token = 'tok';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(Response.json(PAGE)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const get = (qs = '') => GET(new NextRequest(`${ORIGIN}/api/notifications${qs}`));
const post = (path: string, origin: string | null = ORIGIN) =>
  new NextRequest(`${ORIGIN}/api/notifications${path}`, {
    method: 'POST',
    headers: origin === null ? {} : { origin },
  });
const markOne = (id: string, origin?: string | null) =>
  readOne(post(`/${id}/read`, origin), { params: Promise.resolve({ id }) });

describe('GET /api/notifications', () => {
  it('calls the API as the user in the chosen tenant and returns the page', async () => {
    const res = await get('?page=2&limit=10');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PAGE);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/notifications?page=2&limit=10');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok', 'x-tenant': 'globex' });
  });

  it('forwards only page and limit, and only in range', async () => {
    await get('?page=0&limit=500&kind=x');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test/notifications');
  });

  it('answers 401 without a session and never calls the API', async () => {
    state.token = null;
    expect((await get()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an answer that does not match the contract (an extra field)', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ ...PAGE, items: [{ ...PAGE.items[0], fileName: 'SAMPLE.pdf' }] }),
    );
    const res = await get();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 'API_ERROR' });
  });

  it('passes a 429 on with Retry-After and nothing else', async () => {
    fetchMock.mockResolvedValueOnce(rateLimitedUpstream());
    await expectRateLimitedPassedOn(await get());
  });

  it('answers 502 API_UNREACHABLE when the API is down', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await (await get()).json()).toEqual({ code: 'API_UNREACHABLE' });
  });
});

describe('POST /api/notifications/:id/read and /read-all', () => {
  beforeEach(() =>
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 }))),
  );

  it('marks one as read through the API', async () => {
    const res = await markOne(ID);
    expect(res.status).toBe(204);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://api.test/notifications/${ID}/read`);
    expect(init.method).toBe('POST');
  });

  it('marks all as read through the API', async () => {
    const res = await readAll(post('/read-all'));
    expect(res.status).toBe(204);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test/notifications/read-all');
  });

  it.each([
    ['another site', 'https://evil.test'],
    ['no Origin header', null],
  ])('refuses a POST from %s with 403', async (_name, origin) => {
    expect((await markOne(ID, origin)).status).toBe(403);
    expect((await readAll(post('/read-all', origin))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 404 for an id that is not a uuid, without calling the API', async () => {
    expect((await markOne('../documents')).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes on the API's 404 (someone else's notification) and the demo's 403 code", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ detail: 'x' }, { status: 404 }));
    expect((await markOne(ID)).status).toBe(404);
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'DEMO_READ_ONLY' }, { status: 403 }));
    const demo = await readAll(post('/read-all'));
    expect(demo.status).toBe(403);
    expect(await demo.json()).toEqual({ code: 'DEMO_READ_ONLY' });
  });
});
