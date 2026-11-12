import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ask, AskError, QA_MAX_STREAM_CHARS, toStreamEvent } from './ask-client';
import type { QaStreamEvent } from 'contracts';

const DOC = '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11';
const CITATIONS = {
  citations: [
    {
      n: 1,
      documentId: DOC,
      documentVersion: 1,
      invoiceId: '9b5e7f40-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      chunkId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      refs: [{ document_id: DOC, field_path: 'seller.name', page: null }],
    },
  ],
};
const ANSWER = [
  'event: token\ndata: {"text":"Ink "}\n\n',
  'event: token\ndata: {"text":"[1]"}\n\n',
  `event: citations\ndata: ${JSON.stringify(CITATIONS)}\n\n`,
  'event: done\ndata: {}\n\n',
].join('');

const fetchMock = vi.fn();
const sse = (body: BodyInit) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

async function collect(signal = new AbortController().signal) {
  const events: QaStreamEvent[] = [];
  await ask('Ai bán mực?', (e) => events.push(e), signal);
  return events;
}

describe('ask', () => {
  it('posts the question as JSON and gives each validated event in order', async () => {
    fetchMock.mockResolvedValue(sse(ANSWER));
    const events = await collect();
    expect(events.map((e) => e.event)).toEqual(['token', 'token', 'citations', 'done']);
    expect(events[2]).toEqual({ event: 'citations', data: CITATIONS });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/qa/ask');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"question":"Ai bán mực?"}');
  });

  it('gives events as they arrive, before the stream has ended', async () => {
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: token\ndata: {"text":"a"}\n\n'));
        close = () => {
          c.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'));
          c.close();
        };
      },
    });
    fetchMock.mockResolvedValue(sse(body));
    const seen: string[] = [];
    const finished = ask('q', (e) => seen.push(e.event), new AbortController().signal);
    await vi.waitFor(() => expect(seen).toEqual(['token']));
    close();
    await finished;
    expect(seen).toEqual(['token', 'done']);
  });

  it('stops at the first event that does not match the contract', async () => {
    fetchMock.mockResolvedValue(
      sse(
        'event: token\ndata: {"text":"a"}\n\nevent: token\ndata: {"text":""}\n\nevent: done\ndata: {}\n\n',
      ),
    );
    const seen: string[] = [];
    const err = await ask('q', (e) => seen.push(e.event), new AbortController().signal).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AskError);
    expect((err as AskError).failure).toEqual({ kind: 'stream' });
    expect(seen).toEqual(['token']);
  });

  it('stops a stream that is too long, and an event too large, as a broken stream', async () => {
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        // Endless valid events: only the total limit can stop it.
        c.enqueue(
          new TextEncoder().encode(`event: token\ndata: {"text":"${'a'.repeat(60_000)}"}\n\n`),
        );
      },
    });
    fetchMock.mockResolvedValue(sse(big));
    await expect(collect()).rejects.toMatchObject({ failure: { kind: 'stream' } });
    expect(QA_MAX_STREAM_CHARS).toBeGreaterThan(1_000_000);

    fetchMock.mockResolvedValue(sse(`event: token\ndata: ${'b'.repeat(2 * 1024 * 1024)}`));
    await expect(collect()).rejects.toMatchObject({ failure: { kind: 'stream' } });
  });

  it('fails when the stream ends before done: what arrived may be incomplete', async () => {
    fetchMock.mockResolvedValue(sse('event: token\ndata: {"text":"a"}\n\n'));
    await expect(collect()).rejects.toMatchObject({ failure: { kind: 'stream' } });
  });

  it('reads the listed code of an error answer, and nothing else from its body', async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'AI_SERVICE_UNAVAILABLE' }, { status: 503 }));
    await expect(collect()).rejects.toMatchObject({
      failure: { kind: 'http', status: 503, code: 'AI_SERVICE_UNAVAILABLE' },
    });
    fetchMock.mockResolvedValue(Response.json({ code: '<script>' }, { status: 400 }));
    await expect(collect()).rejects.toMatchObject({
      failure: { kind: 'http', status: 400, code: undefined },
    });
  });

  it('a 200 that is not an event stream is a stream failure; no answer at all is a network one', async () => {
    fetchMock.mockResolvedValue(Response.json({ answer: 'x' }));
    await expect(collect()).rejects.toMatchObject({ failure: { kind: 'stream' } });
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(collect()).rejects.toMatchObject({ failure: { kind: 'network' } });
  });

  it('aborting passes the signal to fetch and stops reading a stream in progress', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: token\ndata: {"text":"a"}\n\n'));
      },
    });
    fetchMock.mockResolvedValue(sse(body));
    const controller = new AbortController();
    const seen: string[] = [];
    const finished = ask('q', (e) => seen.push(e.event), controller.signal).catch(
      (e: unknown) => e,
    );
    await vi.waitFor(() => expect(seen).toEqual(['token']));
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].signal).toBe(controller.signal);
    controller.abort();
    const err = await finished;
    expect(err).not.toBeInstanceOf(AskError);
    expect(seen).toEqual(['token']);
  });
});

describe('toStreamEvent', () => {
  it('refuses an unknown name, broken JSON, extra keys and a prototype key', () => {
    expect(toStreamEvent({ event: 'token', data: '{"text":"a"}' })).toEqual({
      event: 'token',
      data: { text: 'a' },
    });
    expect(toStreamEvent({ event: 'html', data: '{"text":"a"}' })).toBeNull();
    expect(toStreamEvent({ event: 'token', data: '{"text":' })).toBeNull();
    expect(toStreamEvent({ event: 'token', data: '{"text":"a","html":"<b>"}' })).toBeNull();
    expect(toStreamEvent({ event: 'toString', data: '{}' })).toBeNull();
    expect(toStreamEvent({ event: 'refusal', data: '{"reason":"MADE_UP"}' })).toBeNull();
  });
});
