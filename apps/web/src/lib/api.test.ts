import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const state = {
  token: 'tok' as string | null,
  tenants: ['acme', 'globex'],
  cookie: undefined as string | undefined,
};
vi.mock('@/auth/session', () => ({
  getAccessToken: () => Promise.resolve(state.token),
  getSession: () => Promise.resolve({ tenants: state.tenants }),
}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'tenant' && state.cookie ? { value: state.cookie } : undefined,
    }),
}));

import { apiGet } from './api';

const fetchMock = vi.fn();
beforeEach(() => {
  state.token = 'tok';
  state.cookie = undefined;
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown = {}) =>
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('apiGet', () => {
  it('sends the bearer token and the tenant from the cookie', async () => {
    state.cookie = 'globex';
    reply(200, { ok: 1 });
    expect(await apiGet('/auth/me')).toEqual({ kind: 'ok', data: { ok: 1 } });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://localhost:3001/auth/me');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok', 'x-tenant': 'globex' });
  });

  it('ignores a cookie naming a tenant the user does not have', async () => {
    state.cookie = 'initech';
    reply(200);
    await apiGet('/auth/me');
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers['x-tenant']).toBe('acme');
  });

  it('does not call the API without a token', async () => {
    state.token = null;
    expect(await apiGet('/auth/me')).toEqual({ kind: 'unauthorized' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 401, 403 (with its code), 5xx and network failure', async () => {
    reply(401);
    expect(await apiGet('/x')).toEqual({ kind: 'unauthorized' });
    reply(403, { code: 'TENANT_NOT_MEMBER' });
    expect(await apiGet('/x')).toEqual({ kind: 'forbidden', code: 'TENANT_NOT_MEMBER' });
    reply(403, { code: { evil: true } });
    expect(await apiGet('/x')).toEqual({ kind: 'forbidden', code: undefined });
    reply(500);
    expect(await apiGet('/x')).toEqual({ kind: 'unavailable' });
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await apiGet('/x')).toEqual({ kind: 'unavailable' });
  });
});
