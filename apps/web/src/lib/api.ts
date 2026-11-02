import 'server-only';
import { cookies } from 'next/headers';
import { getAccessToken, getSession } from '@/auth/session';
import { resolveTenant, TENANT_COOKIE } from '@/auth/tenant';

// Local default so dev needs no extra variable; set API_BASE_URL anywhere else.
export const apiBaseUrl = () => process.env.API_BASE_URL ?? 'http://localhost:3001';

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unauthorized' } // no/expired token: sign in again
  | { kind: 'forbidden'; code?: string } // identity fine, tenant/permission refused
  | { kind: 'unavailable' };

/**
 * The tenant this request works in: the cookie if it names one of the user's own tenants, else
 * their first. The API re-checks it against the signed token, so this is a convenience, not a
 * security decision.
 */
export async function currentTenant(): Promise<string | undefined> {
  const session = await getSession();
  const cookie = (await cookies()).get(TENANT_COOKIE)?.value;
  return resolveTenant(cookie, session?.tenants ?? []);
}

/** Server-side call to the API with the user's token and chosen tenant. The browser never sees the token. */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const [token, tenant] = await Promise.all([getAccessToken(), currentTenant()]);
  if (token === null) return { kind: 'unauthorized' };
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenant !== undefined) headers['x-tenant'] = tenant;
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, { headers, cache: 'no-store' });
  } catch {
    return { kind: 'unavailable' };
  }
  if (res.status === 401) return { kind: 'unauthorized' };
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    return { kind: 'forbidden', code: typeof body.code === 'string' ? body.code : undefined };
  }
  if (!res.ok) return { kind: 'unavailable' };
  return { kind: 'ok', data: (await res.json()) as T };
}

/** W3C trace-context shape only; anything else is dropped rather than relayed. */
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * Headers for a BFF route that forwards a browser request to the API: the bearer token, the chosen
 * tenant and a well-formed traceparent. `null` when there is no token (answer 401, call nothing).
 */
export async function upstreamHeaders(
  traceparent: string | null,
): Promise<Record<string, string> | null> {
  const [token, tenant] = await Promise.all([getAccessToken(), currentTenant()]);
  if (token === null) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenant !== undefined) headers['x-tenant'] = tenant;
  if (traceparent !== null && TRACEPARENT.test(traceparent)) headers.traceparent = traceparent;
  return headers;
}
