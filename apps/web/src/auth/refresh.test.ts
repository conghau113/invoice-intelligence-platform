import { afterEach, describe, expect, it, vi } from 'vitest';
import { needsRefresh, refreshAccessToken } from './refresh';

const cfg = { issuer: 'http://kc/realms/invoice', clientId: 'web', clientSecret: 's' };
const now = () => Math.floor(Date.now() / 1000);
let n = 0;
// Distinct refresh token per test: results are remembered per token.
const stale = () => ({ accessToken: 'old', refreshToken: `r-${n++}`, expiresAt: now() - 5 });
const okBody = { access_token: 'new', refresh_token: 'rotated', expires_in: 300 };

afterEach(() => vi.unstubAllGlobals());

describe('needsRefresh', () => {
  it('is false with plenty of time left, true near expiry or without expiry', () => {
    expect(needsRefresh({ expiresAt: now() + 300 })).toBe(false);
    expect(needsRefresh({ expiresAt: now() + 30 })).toBe(true);
    expect(needsRefresh({})).toBe(true);
  });
});

describe('refreshAccessToken', () => {
  it('returns the rotated tokens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(okBody)),
    );
    const r = await refreshAccessToken(stale(), cfg);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.token.accessToken).toBe('new');
    expect(r.token.refreshToken).toBe('rotated');
    expect(r.token.expiresAt).toBeGreaterThan(now() + 290);
  });

  it('is "rejected" when Keycloak refuses the token (invalid_grant)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })),
    );
    expect((await refreshAccessToken(stale(), cfg)).kind).toBe('rejected');
  });

  it('is "unavailable" (not a logout) on 5xx and on network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 503 })),
    );
    expect((await refreshAccessToken(stale(), cfg)).kind).toBe('unavailable');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    expect((await refreshAccessToken(stale(), cfg)).kind).toBe('unavailable');
  });

  it('retries after a transient failure (failure is not remembered)', async () => {
    const t = stale();
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('x', { status: 503 }))
      .mockResolvedValueOnce(Response.json(okBody));
    vi.stubGlobal('fetch', f);
    expect((await refreshAccessToken(t, cfg)).kind).toBe('unavailable');
    await Promise.resolve();
    expect((await refreshAccessToken(t, cfg)).kind).toBe('ok');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('calls the token endpoint once for concurrent refreshes of the same token', async () => {
    const f = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return Response.json(okBody);
    });
    vi.stubGlobal('fetch', f);
    const t = stale();
    const results = await Promise.all(Array.from({ length: 5 }, () => refreshAccessToken(t, cfg)));
    expect(f).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
  });

  it('reuses the result for a late request that still carries the old token', async () => {
    const f = vi.fn(async () => Response.json(okBody));
    vi.stubGlobal('fetch', f);
    const t = stale();
    await refreshAccessToken(t, cfg); // request A finished
    const late = await refreshAccessToken(t, cfg); // request B sent before A's Set-Cookie arrived
    expect(late.kind).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
  });
});
