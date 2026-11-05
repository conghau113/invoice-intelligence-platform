import type { Invoice } from 'contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveDocument } from './approve-client';

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

  it('a success of an unexpected shape is not reported as a success', async () => {
    fetchMock.mockResolvedValue(Response.json({ nope: true }));
    await expect(approveDocument(ID, 1, invoice)).resolves.toEqual({ ok: false, kind: 'error' });
  });
});
