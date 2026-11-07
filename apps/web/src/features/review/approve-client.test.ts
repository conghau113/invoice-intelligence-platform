import type { Invoice } from 'contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveDocument, reopenDocument } from './approve-client';

const ID = '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11';
const invoice = { invoiceNo: 'SAMPLE' } as Invoice;
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reopenDocument', () => {
  it('posts no body, with the given version as a quoted If-Match', async () => {
    fetchMock.mockResolvedValue(Response.json({ id: ID, status: 'needs_review', version: 4 }));
    await expect(reopenDocument(ID, 3)).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body?: unknown },
    ];
    expect(url).toBe(`/api/documents/${ID}/reopen`);
    expect(init.method).toBe('POST');
    expect(init.headers['if-match']).toBe('"3"');
    expect(init.body).toBeUndefined();
  });

  it.each([
    [401, 'session'],
    [403, 'forbidden'],
    [404, 'notFound'],
    [409, 'conflict'],
    [400, 'error'],
    [413, 'error'],
    [422, 'error'],
    [428, 'error'],
    [502, 'error'],
  ])('%i -> %s', async (status, kind) => {
    fetchMock.mockResolvedValue(Response.json({}, { status }));
    await expect(reopenDocument(ID, 1)).resolves.toEqual({ ok: false, kind });
  });

  it("a reopen refused for a request problem says the server's reason, not a form error", async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'IF_MATCH_REQUIRED' }, { status: 400 }));
    await expect(reopenDocument(ID, 1)).resolves.toEqual({
      ok: false,
      kind: 'error',
      code: 'IF_MATCH_REQUIRED',
    });
  });

  it('the limit on reopening is told apart from a conflict, though both are 409', async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'REOPEN_LIMIT_REACHED' }, { status: 409 }));
    await expect(reopenDocument(ID, 20)).resolves.toEqual({ ok: false, kind: 'limit' });
  });

  it('a network failure or an API that is down is "unreachable"', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await expect(reopenDocument(ID, 1)).resolves.toEqual({ ok: false, kind: 'unreachable' });
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'API_UNREACHABLE' }, { status: 502 }));
    await expect(reopenDocument(ID, 1)).resolves.toEqual({ ok: false, kind: 'unreachable' });
  });
});

describe('approveDocument', () => {
  it('posts the invoice with the given version as a quoted If-Match', async () => {
    fetchMock.mockResolvedValue(Response.json({ corrections: 2 }));
    await expect(approveDocument(ID, 3, invoice)).resolves.toEqual({ ok: true, corrections: 2 });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(`/api/documents/${ID}/approve`);
    expect(init.method).toBe('POST');
    expect(init.headers['if-match']).toBe('"3"');
    expect(JSON.parse(init.body)).toEqual(invoice);
  });

  it.each([
    [400, 'invalid'],
    [401, 'session'],
    [403, 'forbidden'],
    [404, 'notFound'],
    [409, 'conflict'],
    [413, 'tooLarge'],
    [422, 'invalid'],
    [428, 'error'],
    [502, 'error'],
  ])('%i -> %s', async (status, kind) => {
    fetchMock.mockResolvedValue(Response.json({}, { status }));
    await expect(approveDocument(ID, 1, invoice)).resolves.toEqual({ ok: false, kind });
  });

  it('the API or the web server being unreachable is told apart from an error', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'API_UNREACHABLE' }, { status: 502 }));
    await expect(approveDocument(ID, 1, invoice)).resolves.toEqual({
      ok: false,
      kind: 'unreachable',
    });
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    await expect(approveDocument(ID, 1, invoice)).resolves.toEqual({
      ok: false,
      kind: 'unreachable',
    });
  });

  it("with no more specific message, an approval failure carries the server's listed code", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ code: 'EXTRACTION_DATA_INVALID' }, { status: 500 }),
    );
    await expect(approveDocument(ID, 1, invoice)).resolves.toEqual({
      ok: false,
      kind: 'error',
      code: 'EXTRACTION_DATA_INVALID',
    });
  });

  it('a code that is not on the list is dropped; a specific kind keeps its own message', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'Nguyen Van A' }, { status: 500 }));
    await expect(approveDocument(ID, 1, invoice)).resolves.toEqual({ ok: false, kind: 'error' });
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'VERSION_CONFLICT' }, { status: 409 }));
    await expect(approveDocument(ID, 1, invoice)).resolves.toEqual({
      ok: false,
      kind: 'conflict',
    });
  });

  it('a success of an unexpected shape is not reported as a success', async () => {
    fetchMock.mockResolvedValue(Response.json({ nope: true }));
    await expect(approveDocument(ID, 1, invoice)).resolves.toEqual({ ok: false, kind: 'error' });
  });
});
