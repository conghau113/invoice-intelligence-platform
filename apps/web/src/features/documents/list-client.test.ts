import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDocuments, ListError } from './list-client';
import type { ListParams } from './list-params';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = {
  items: [
    {
      id: '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11',
      status: 'queued',
      sourceType: 'xml',
      version: 1,
      createdAt: '2026-10-22T03:04:05.123Z',
    },
  ],
  meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
};
const base: ListParams = { sort: '-createdAt', page: 1, pageSize: 20 };
const kind = async () => {
  try {
    await fetchDocuments(base);
  } catch (e) {
    return e instanceof ListError ? e.kind : 'other';
  }
  return 'none';
};

describe('fetchDocuments', () => {
  it('asks the BFF route with the parameters and returns the parsed page', async () => {
    fetchMock.mockResolvedValue(Response.json(ok));
    const page = await fetchDocuments({
      ...base,
      sort: 'createdAt',
      status: 'failed',
      page: 3,
      pageSize: 50,
    });
    expect(page).toEqual(ok);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/documents?status=failed&sort=createdAt&page=3&limit=50',
    );
  });

  it.each([
    [401, {}, 'session'],
    [403, { code: 'FORBIDDEN_PERMISSION' }, 'forbidden'],
    [502, { code: 'API_UNREACHABLE' }, 'unreachable'],
    [502, { code: 'API_ERROR' }, 'error'],
    [500, {}, 'error'],
  ])('maps %s %j to "%s"', async (status, body, expected) => {
    fetchMock.mockResolvedValue(Response.json(body, { status }));
    expect(await kind()).toBe(expected);
  });

  it('reports an unreachable web server', async () => {
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'));
    expect(await kind()).toBe('unreachable');
  });

  it('refuses a page of an unexpected shape', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ items: [{ ...ok.items[0], status: 'weird' }], meta: ok.meta }),
    );
    expect(await kind()).toBe('error');
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));
    expect(await kind()).toBe('error');
  });
});
