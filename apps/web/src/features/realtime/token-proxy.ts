import 'server-only';
import { RealtimeTokenSchema } from 'contracts';
import { NextResponse } from 'next/server';
import { bffError, rateLimited } from '@/lib/bff-error';

/** Local default, like `apiBaseUrl`: `pnpm dev:api` listens there. */
const DEV_REALTIME_URL = 'http://localhost:3001';

/**
 * Where browsers open the socket: the API's public origin. Server-only and read at request time,
 * so one build serves any deployment. Outside production it defaults to the local API. In
 * production, not set or not a bare http(s) origin = realtime off: the token route answers 404 and
 * the web keeps polling (the public demo, which has no public route to the API).
 */
export function realtimePublicUrl(
  raw = process.env.REALTIME_PUBLIC_URL,
  production = process.env.NODE_ENV === 'production',
): string | null {
  if (raw === undefined || raw === '') return production ? null : DEV_REALTIME_URL;
  try {
    const url = new URL(raw);
    const bare = url.origin === raw && (url.protocol === 'http:' || url.protocol === 'https:');
    return bare ? raw : null;
  } catch {
    return null;
  }
}

/** What the browser gets: the API's short-lived token and where to use it. Never the access token. */
export async function answerTokenRequest(upstream: Response, url: string): Promise<NextResponse> {
  if (upstream.ok) {
    const parsed = RealtimeTokenSchema.safeParse(await upstream.json().catch(() => null));
    if (!parsed.success) return bffError('API_ERROR', 502);
    return NextResponse.json(
      { ...parsed.data, url },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }
  const limited = rateLimited(upstream);
  if (limited !== null) return limited;
  // 404: realtime is off in the API (no REALTIME_TOKEN_SECRET). 401/403: signed out, not a member,
  // or the read-only demo. The upstream body is never passed on.
  if (upstream.status === 404) return bffError('NOT_FOUND', 404);
  if (upstream.status === 401) return bffError('UNAUTHENTICATED', 401);
  if (upstream.status === 403) return bffError('FORBIDDEN', 403);
  return bffError('API_ERROR', 502);
}
