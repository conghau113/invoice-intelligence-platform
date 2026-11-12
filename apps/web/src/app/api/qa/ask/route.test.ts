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

import { POST } from './route';

const ORIGIN = 'http://localhost:3000';
const SSE = 'event: token\ndata: {"text":"Hi [1]"}\n\nevent: done\ndata: {}\n\n';
const fetchMock = vi.fn();

const sse = (body: BodyInit) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });

beforeEach(() => {
  vi.stubEnv('API_BASE_URL', 'http://api.test');
  state.token = 'tok';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(sse(SSE)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const post = (
  headers: Record<string, string> = {},
  body = '{"question":"Ai bán mực in?"}',
  signal?: AbortSignal,
) =>
  POST(
    new NextRequest(`${ORIGIN}/api/qa/ask`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        // What the browser sends for a string body.
        'content-length': String(Buffer.byteLength(body)),
        ...headers,
      },
      body,
      signal,
    }),
  );

type Init = RequestInit & { headers: Record<string, string>; signal: AbortSignal };
const lastCall = () => fetchMock.mock.calls[0] as [string, Init];

describe('POST /api/qa/ask', () => {
  it('forwards the question with the token and tenant, and passes the events through', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(await res.text()).toBe(SSE);
    const [url, init] = lastCall();
    expect(url).toBe('http://api.test/qa/ask');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer tok',
      'x-tenant': 'globex',
      'content-type': 'application/json',
    });
    expect(await new Response(init.body).text()).toBe('{"question":"Ai bán mực in?"}');
  });

  it('streams: the first event reaches the browser before the API has finished', async () => {
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: token\ndata: {"text":"a"}\n\n'));
        finish = () => {
          controller.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'));
          controller.close();
        };
      },
    });
    fetchMock.mockImplementation(() => Promise.resolve(sse(body)));
    const res = await post();
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe('event: token\ndata: {"text":"a"}\n\n');
    finish();
    expect((await reader.read()).value).toBe('event: done\ndata: {}\n\n');
  });

  it('closing the browser connection aborts the call to the API', async () => {
    const browser = new AbortController();
    let seen: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: Init) => {
      seen = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    });
    const pending = post({}, undefined, browser.signal);
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen?.aborted).toBe(false);
    browser.abort();
    await pending;
    expect(seen?.aborted).toBe(true);
  });

  it('gives up after 90 s, not sooner than the API may take, with a listed code', async () => {
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort(new DOMException('slow', 'TimeoutError')));
    fetchMock.mockImplementation((_url: string, init: Init) => Promise.reject(init.signal.reason));
    const res = await post();
    expect(timeout).toHaveBeenCalledWith(90_000);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('refuses a cross-site post, a non-JSON body, a huge body and a missing session before calling the API', async () => {
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(400);
    expect((await post({ 'content-length': String(64 * 1024) })).status).toBe(413);
    // No length (a chunked body) or a malformed one: the size is unknown, so nothing is sent.
    const chunked = new Headers({ origin: ORIGIN, 'content-type': 'application/json' });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"question":"x"}'));
        c.close();
      },
    });
    const noLength = await POST(
      new NextRequest(`${ORIGIN}/api/qa/ask`, {
        method: 'POST',
        headers: chunked,
        body: stream,
        duplex: 'half',
      } as ConstructorParameters<typeof NextRequest>[1]),
    );
    expect(noLength.status).toBe(400);
    expect((await post({ 'content-length': 'abc' })).status).toBe(400);
    state.token = null;
    expect((await post()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes on a listed status with its code only, never the upstream body', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json(
          { code: 'AI_SERVICE_UNAVAILABLE', detail: 'question: Ai bán mực in?' },
          { status: 503 },
        ),
      ),
    );
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'AI_SERVICE_UNAVAILABLE' });
  });

  it('drops a code that is not on the shared list, keeping the status', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ code: 'x'.repeat(10_000) }, { status: 400 })),
    );
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({});
  });

  it('turns an unexpected answer into 502 API_ERROR: a 500, or a 200 that is not an event stream', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('boom', { status: 500 })));
    expect(await (await post()).json()).toEqual({ code: 'API_ERROR' });
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ answer: 'x' })));
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 'API_ERROR' });
  });

  it('answers 502 API_UNREACHABLE when the API cannot be reached', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 'API_UNREACHABLE' });
  });
});
