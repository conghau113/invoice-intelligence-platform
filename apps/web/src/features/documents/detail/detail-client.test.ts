import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DetailError, fetchDocumentDetail } from './detail-client';
import { loadInvoiceFixture } from './detail-fixtures';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ID = '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11';
const doc = (over: object = {}) => ({
  id: ID,
  status: 'needs_review',
  sourceType: 'xml',
  version: 1,
  createdAt: '2026-10-26T03:04:05.123Z',
  failureCode: null,
  extraction: {
    id: '9b5e7f40-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
    documentVersion: 1,
    source: 'xml',
    data: loadInvoiceFixture(),
    warnings: [],
    createdAt: '2026-10-26T03:04:06.000Z',
  },
  ...over,
});
const kind = async () => {
  try {
    await fetchDocumentDetail(ID);
  } catch (e) {
    return e instanceof DetailError ? e.kind : 'other';
  }
  return 'none';
};

describe('fetchDocumentDetail', () => {
  it('asks the BFF route and returns the parsed document with its invoice', async () => {
    fetchMock.mockResolvedValue(Response.json(doc()));
    const res = await fetchDocumentDetail(ID);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/documents/${ID}`);
    expect(res.extraction?.data.invoiceNo).toBe('0000123');
  });

  it('accepts a document without an extraction (still queued) and a failed one with its code', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(doc({ status: 'queued', extraction: null })));
    expect((await fetchDocumentDetail(ID)).extraction).toBeNull();
    fetchMock.mockResolvedValueOnce(
      Response.json(doc({ status: 'failed', extraction: null, failureCode: 'XML_MALFORMED' })),
    );
    expect((await fetchDocumentDetail(ID)).failureCode).toBe('XML_MALFORMED');
  });

  it('maps the failure statuses to the kinds the screen explains', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }));
    expect(await kind()).toBe('session');
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 403 }));
    expect(await kind()).toBe('forbidden');
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 404 }));
    expect(await kind()).toBe('notFound');
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'API_UNREACHABLE' }, { status: 502 }));
    expect(await kind()).toBe('unreachable');
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'API_ERROR' }, { status: 502 }));
    expect(await kind()).toBe('error');
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await kind()).toBe('unreachable');
  });

  it('refuses a body that is not the shape we expect, including an invoice that fails the contract', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    expect(await kind()).toBe('error');
    fetchMock.mockResolvedValueOnce(Response.json(doc({ status: 'weird' })));
    expect(await kind()).toBe('error');
    const bad = doc();
    (bad.extraction.data as { total: unknown }).total = 1100000.5;
    fetchMock.mockResolvedValueOnce(Response.json(bad));
    expect(await kind()).toBe('error');
  });

  it('lets an abort through as an abort, not as a load error', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    expect(await kind()).toBe('other');
  });
});
