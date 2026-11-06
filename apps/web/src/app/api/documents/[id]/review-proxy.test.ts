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

import { POST as approve } from './approve/route';
import { POST as reopen } from './reopen/route';

const ID = '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11';
const ORIGIN = 'http://localhost:3000';
const RESULT = { id: ID, status: 'changed', version: 4 };
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv('API_BASE_URL', 'http://api.test');
  state.token = 'tok';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(Response.json(RESULT)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const postApprove = (id: string, headers: Record<string, string> = {}) =>
  approve(
    new NextRequest(`${ORIGIN}/api/documents/${id}/approve`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'if-match': '"3"',
        ...headers,
      },
      body: '{"a":1}',
    }),
    { params: Promise.resolve({ id }) },
  );

const postReopen = (id: string, headers: Record<string, string> = {}) =>
  reopen(
    new NextRequest(`${ORIGIN}/api/documents/${id}/reopen`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'if-match': '"3"', ...headers },
    }),
    { params: Promise.resolve({ id }) },
  );

describe.each([
  ['approve', postApprove],
  ['reopen', postReopen],
])('POST /api/documents/[id]/%s', (action, post) => {
  it('forwards If-Match with the token and tenant, and returns the result', async () => {
    const res = await post(ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url).toBe(`http://api.test/documents/${ID}/${action}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer tok',
      'x-tenant': 'globex',
      'if-match': '"3"',
    });
  });

  it('refuses a cross-site post without calling the API', async () => {
    const res = await post(ID, { origin: 'http://evil.test' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a uuid, so nothing can be appended to the path', async () => {
    const res = await post('..%2Fadmin');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 without a token and calls nothing', async () => {
    state.token = null;
    const res = await post(ID);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 409, 413, 422, 428])(
    'passes on %i with our code, never the upstream body',
    async (status) => {
      fetchMock.mockResolvedValue(
        Response.json({ code: 'SOME_CODE', detail: 'SAMPLE upstream text' }, { status }),
      );
      const res = await post(ID);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ code: 'SOME_CODE' });
    },
  );

  it('an API fault becomes 502 API_ERROR; an API that is down becomes 502 API_UNREACHABLE', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ detail: 'x' }, { status: 500 }));
    const fault = await post(ID);
    expect(fault.status).toBe(502);
    expect(await fault.json()).toEqual({ code: 'API_ERROR' });

    fetchMock.mockRejectedValueOnce(new Error('down'));
    const down = await post(ID);
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ code: 'API_UNREACHABLE' });
  });
});

describe('what only approve does: it carries the invoice', () => {
  it('forwards the body as JSON', async () => {
    await postApprove(ID);
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: ReadableStream },
    ];
    expect(init.headers['content-type']).toBe('application/json');
    expect(await new Response(init.body).text()).toBe('{"a":1}');
  });

  it('refuses a body that is not JSON', async () => {
    const res = await postApprove(ID, { 'content-type': 'text/plain' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a body declared over the limit without calling the API', async () => {
    const res = await postApprove(ID, { 'content-length': String(1024 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: 'BODY_TOO_LARGE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('what only reopen does: it has no body', () => {
  it('sends none', async () => {
    await postReopen(ID);
    const [, init] = fetchMock.mock.calls[0] as [string, { body?: unknown }];
    expect(init.body).toBeUndefined();
  });
});
