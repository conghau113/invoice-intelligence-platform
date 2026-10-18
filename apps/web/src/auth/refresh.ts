import type { JWT } from 'next-auth/jwt';

/** Refresh when fewer than this many seconds remain on the access token. */
export const REFRESH_SKEW_SECONDS = 60;
/** How long a finished refresh is remembered, see `recent` below. */
export const REUSE_WINDOW_MS = 30_000;
const TIMEOUT_MS = 5_000;

export interface RefreshConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

/**
 * ok: new tokens. rejected: Keycloak refused the refresh token (revoked/expired/reused)
 * -> the session is over. unavailable: Keycloak 5xx/timeout/network -> keep the session,
 * try again on a later request.
 */
export type RefreshResult =
  { kind: 'ok'; token: JWT } | { kind: 'rejected' } | { kind: 'unavailable' };

// Rotation (revokeRefreshToken, no reuse) means one refresh token = one refresh.
// Concurrent requests share the in-flight call (single-flight). Requests that were sent
// BEFORE the browser received the new cookie arrive after it finished and still carry the
// old token, so the finished result is remembered for a short window as well.
const calls = new Map<string, { promise: Promise<RefreshResult>; startedAt: number }>();

export function needsRefresh(token: JWT, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return !token.expiresAt || token.expiresAt - nowSeconds < REFRESH_SKEW_SECONDS;
}

async function requestRefresh(token: JWT, cfg: RefreshConfig): Promise<RefreshResult> {
  try {
    const res = await fetch(`${cfg.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: token.refreshToken ?? '',
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 400 || res.status === 401) return { kind: 'rejected' };
    if (!res.ok) return { kind: 'unavailable' };
    const data = (await res.json()) as TokenResponse;
    return {
      kind: 'ok',
      token: {
        ...token,
        accessToken: data.access_token,
        // Rotation: Keycloak returns a new refresh token; keep the old one only if absent.
        refreshToken: data.refresh_token ?? token.refreshToken,
        idToken: data.id_token ?? token.idToken,
        expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
      },
    };
  } catch {
    // No token or response body in errors/logs.
    return { kind: 'unavailable' };
  }
}

export function refreshAccessToken(token: JWT, cfg: RefreshConfig): Promise<RefreshResult> {
  const now = Date.now();
  for (const [k, v] of calls) if (now - v.startedAt > REUSE_WINDOW_MS) calls.delete(k);

  const key = token.refreshToken ?? '';
  const existing = calls.get(key);
  if (existing) return existing.promise;

  const promise = requestRefresh(token, cfg);
  calls.set(key, { promise, startedAt: now });
  // Transient failures must not be cached: the next request should retry.
  void promise.then((r) => {
    if (r.kind === 'unavailable') calls.delete(key);
  });
  return promise;
}
