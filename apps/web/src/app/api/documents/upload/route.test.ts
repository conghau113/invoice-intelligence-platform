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

import { POST } from './route';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
  vi.stubEnv('NEXTAUTH_SECRET', 'x'.repeat(40));
  vi.stubEnv('KEYCLOAK_ISSUER', 'http://kc/realms/invoice');
  vi.stubEnv('KEYCLOAK_CLIENT_ID', 'web');
  vi.stubEnv('KEYCLOAK_CLIENT_SECRET', 'cs');
  vi.stubEnv('API_BASE_URL', 'http://api.test');
  state.token = 'tok';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ id: 'd1', status: 'queued' }, { status: 201 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function upload(opts: { origin?: string | null; headers?: Record<string, string> } = {}) {
  const { origin = 'http://localhost:3000', headers = {} } = opts;
  const form = new FormData();
  form.append('file', new Blob(['<?xml version="1.0"?><a/>']), 'a.xml');
  const h: Record<string, string> = { 'idempotency-key': 'key-1', ...headers };
  if (origin) h.origin = origin;
  return POST(
    new NextRequest('http://localhost:3000/api/documents/upload', {
      method: 'POST',
      headers: h,
      body: form,
    }),
  );
}

describe('POST /api/documents/upload', () => {
  it('forwards the body as a stream with token, tenant, key and the same multipart boundary', async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'd1', status: 'queued' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { duplex?: string }];
    expect(url).toBe('http://api.test/documents/upload');
    const h = init.headers as Record<string, string>;
    expect(h).toMatchObject({
      authorization: 'Bearer tok',
      'x-tenant': 'globex',
      'idempotency-key': 'key-1',
    });
    expect(h['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(init.duplex).toBe('half');
    // The bytes that reach the API are the multipart body the browser sent.
    const sent = await new Response(init.body as ReadableStream).text();
    expect(sent).toContain('name="file"');
    expect(sent).toContain('<?xml version="1.0"?><a/>');
  });

  it('passes the API status, problem body and replay header through unchanged', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'UNSUPPORTED_FILE_TYPE' }), {
        status: 415,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
    const res = await upload();
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ code: 'UNSUPPORTED_FILE_TYPE' });

    fetchMock.mockResolvedValue(
      Response.json({ id: 'd1', status: 'queued' }, { headers: { 'idempotent-replayed': 'true' } }),
    );
    const replay = await upload();
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  it.each([
    ['a foreign origin', { origin: 'http://evil.example' }],
    ['no origin', { origin: null }],
  ])('refuses %s and never calls the API', async (_l, opts) => {
    expect((await upload(opts)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 401 without a usable token, and never calls the API', async () => {
    state.token = null;
    expect((await upload()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a body that is not multipart, and one over the limit', async () => {
    const plain = await POST(
      new NextRequest('http://localhost:3000/api/documents/upload', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(plain.status).toBe(400);
    const big = await upload({ headers: { 'content-length': String(12 * 1024 * 1024) } });
    expect(big.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 502 when the API is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await upload()).status).toBe(502);
  });
});
