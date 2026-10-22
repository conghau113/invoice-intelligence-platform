import { NextResponse, type NextRequest } from 'next/server';
import { getAccessToken } from '@/auth/session';
import { parseListParams, toApiQuery } from '@/features/documents/list-params';
import { apiBaseUrl, currentTenant } from '@/lib/api';

/** The browser asks with `limit` (the API's word); the parser reads the URL's `pageSize`. */
function readApiParams(search: URLSearchParams): URLSearchParams {
  const copy = new URLSearchParams(search);
  const limit = copy.get('limit');
  if (limit !== null) copy.set('pageSize', limit);
  return copy;
}

/**
 * List proxy: the browser holds no token (httpOnly cookie, ADR 0006), so TanStack Query asks here
 * and this route calls GET /documents with the bearer token and X-Tenant. Only the parameters we
 * know are forwarded, re-built from the parsed values; nothing from the URL passes through as-is.
 * The response is not logged. A read, so no origin check: a cross-site page cannot read the answer.
 */
export async function GET(req: NextRequest) {
  const [token, tenant] = await Promise.all([getAccessToken(), currentTenant()]);
  if (token === null) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  // `limit` is the API's name for what the URL calls `pageSize`; unknown parameters are gone.
  const query = toApiQuery(parseListParams(readApiParams(req.nextUrl.searchParams)));
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenant !== undefined) headers['x-tenant'] = tenant;
  const traceparent = req.headers.get('traceparent');
  // W3C trace-context shape only; anything else is dropped rather than relayed.
  if (
    traceparent !== null &&
    /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(traceparent)
  ) {
    headers.traceparent = traceparent;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/documents?${query}`, { headers, cache: 'no-store' });
  } catch {
    return NextResponse.json({ code: 'API_UNREACHABLE' }, { status: 502 });
  }
  if (upstream.ok) return NextResponse.json(await upstream.json(), { status: 200 });

  // Pass on only the status class and our own error code, never the upstream body.
  const body = (await upstream.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === 'string' ? body.code : undefined;
  if (upstream.status === 401 || upstream.status === 403) {
    return NextResponse.json({ code }, { status: upstream.status });
  }
  return NextResponse.json({ code: 'API_ERROR' }, { status: 502 });
}
