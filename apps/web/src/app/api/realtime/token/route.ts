import type { NextRequest } from 'next/server';
import { authEnv } from '@/auth/env';
import { isSameOrigin } from '@/auth/logout';
import { answerTokenRequest, realtimePublicUrl } from '@/features/realtime/token-proxy';
import { apiBaseUrl, upstreamHeaders } from '@/lib/api';
import { bffError } from '@/lib/bff-error';

/**
 * Handshake token for the realtime socket (T6.4, ADR 0006): this server holds the access token and
 * asks the API for a 60-second token that only opens a socket for the current tenant. The browser
 * calls this before every (re)connect. Same-origin POST: never cached, never readable cross-site.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req.headers.get('origin'), authEnv().NEXTAUTH_URL)) {
    return bffError('FORBIDDEN', 403);
  }
  const url = realtimePublicUrl();
  if (url === null) return bffError('NOT_FOUND', 404);
  const headers = await upstreamHeaders(req.headers.get('traceparent'));
  if (headers === null) return bffError('UNAUTHENTICATED', 401);

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/realtime/token`, {
      method: 'POST',
      headers,
      cache: 'no-store',
    });
  } catch {
    return bffError('API_UNREACHABLE', 502);
  }
  return answerTokenRequest(upstream, url);
}
