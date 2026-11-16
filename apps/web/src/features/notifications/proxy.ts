import 'server-only';
import { NotificationPageSchema, NOTIFICATIONS_MAX_LIMIT, NOTIFICATIONS_MAX_PAGE } from 'contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { authEnv } from '@/auth/env';
import { isSameOrigin } from '@/auth/logout';
import { apiBaseUrl, upstreamHeaders } from '@/lib/api';
import { bffError, rateLimited } from '@/lib/bff-error';

/** Statuses the bell explains (signed out, not a member, the read-only demo, gone); else API_ERROR. */
const PASSED_ON = new Set([400, 401, 403, 404]);

/** `page` and `limit` rebuilt from integers in range; anything else is left to the API's default. */
export function notificationsQuery(search: URLSearchParams): string {
  const out = new URLSearchParams();
  const page = Number(search.get('page'));
  if (Number.isInteger(page) && page >= 1 && page <= NOTIFICATIONS_MAX_PAGE)
    out.set('page', String(page));
  const limit = Number(search.get('limit'));
  if (Number.isInteger(limit) && limit >= 1 && limit <= NOTIFICATIONS_MAX_LIMIT) {
    out.set('limit', String(limit));
  }
  return out.toString();
}

/**
 * Calls the API as the signed-in user (ADR 0006: the browser holds no token). `write` = a POST
 * that changes state: refused unless it comes from our own origin (cookie auth, SameSite=Lax).
 */
export async function forward(
  req: NextRequest,
  path: string,
  method: 'GET' | 'POST',
): Promise<NextResponse> {
  if (method === 'POST' && !isSameOrigin(req.headers.get('origin'), authEnv().NEXTAUTH_URL)) {
    return bffError('FORBIDDEN', 403);
  }
  const headers = await upstreamHeaders(req.headers.get('traceparent'));
  if (headers === null) return bffError('UNAUTHENTICATED', 401);

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}${path}`, { method, headers, cache: 'no-store' });
  } catch {
    return bffError('API_UNREACHABLE', 502);
  }
  return answer(upstream, method);
}

/** Errors pass on the status and our own code, never the upstream body. */
async function answer(upstream: Response, method: 'GET' | 'POST'): Promise<NextResponse> {
  if (upstream.ok) {
    if (method === 'POST') return new NextResponse(null, { status: 204 });
    // Checked against the contract: nothing the API did not mean to send reaches the browser.
    const parsed = NotificationPageSchema.safeParse(await upstream.json().catch(() => null));
    if (!parsed.success) return bffError('API_ERROR', 502);
    return NextResponse.json(parsed.data, { headers: { 'cache-control': 'no-store' } });
  }
  const limited = rateLimited(upstream);
  if (limited !== null) return limited;
  const body = (await upstream.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === 'string' ? body.code : undefined;
  if (PASSED_ON.has(upstream.status)) {
    return NextResponse.json({ code }, { status: upstream.status });
  }
  return bffError('API_ERROR', 502);
}
