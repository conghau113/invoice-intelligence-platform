import 'server-only';
import { RealtimeTokenSchema } from 'contracts';
import { NextResponse } from 'next/server';
import { bffError, rateLimited } from '@/lib/bff-error';

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
