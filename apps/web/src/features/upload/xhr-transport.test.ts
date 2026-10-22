import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createXhrTransport } from './xhr-transport';

/** Just enough of XMLHttpRequest for the transport; the test fires its events. */
class FakeXhr {
  static last: FakeXhr;
  upload: {
    onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void;
  } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  status = 0;
  responseText = '';
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  aborted = false;
  constructor() {
    FakeXhr.last = this;
  }
  open(m: string, u: string) {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  send(b: unknown) {
    this.body = b;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeXhr));
afterEach(() => vi.unstubAllGlobals());

const send = (onProgress = vi.fn()) =>
  createXhrTransport('/up').send(new File(['x'], 'a.xml'), 'key-1', onProgress);

describe('createXhrTransport', () => {
  it('posts the file in field "file" with the idempotency key and relays progress', () => {
    const onProgress = vi.fn();
    send(onProgress);
    const x = FakeXhr.last;
    expect([x.method, x.url, x.headers['idempotency-key']]).toEqual(['POST', '/up', 'key-1']);
    expect((x.body as FormData).get('file')).toBeInstanceOf(File);
    x.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    x.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(5, 10);
  });

  it('201 = created, 200 = already there', async () => {
    const a = send();
    FakeXhr.last.respond(201, { id: 'd1', status: 'queued' });
    expect(await a.result).toEqual({
      kind: 'ok',
      created: true,
      document: { id: 'd1', status: 'queued' },
    });
    const b = send();
    FakeXhr.last.respond(200, { id: 'd1', status: 'needs_review' });
    expect(await b.result).toMatchObject({ kind: 'ok', created: false });
  });

  it('keeps the API error code and status of a failure', async () => {
    const r = send();
    FakeXhr.last.respond(415, { code: 'UNSUPPORTED_FILE_TYPE', detail: 'x' });
    expect(await r.result).toEqual({
      kind: 'error',
      failure: { status: 415, code: 'UNSUPPORTED_FILE_TYPE' },
    });
  });

  it.each([
    ['a 2xx that is not a document', 201, '<html>'],
    ['an unknown status value', 201, { id: 'd', status: 'weird' }],
  ])('treats %s as an error instead of showing success', async (_l, status, body) => {
    const r = send();
    FakeXhr.last.respond(status, body);
    expect(await r.result).toMatchObject({ kind: 'error' });
  });

  it('maps network failure and abort', async () => {
    const a = send();
    FakeXhr.last.onerror?.();
    expect(await a.result).toEqual({ kind: 'error', failure: {} });
    const b = send();
    b.abort();
    expect(FakeXhr.last.aborted).toBe(true);
    expect(await b.result).toEqual({ kind: 'aborted' });
  });
});
