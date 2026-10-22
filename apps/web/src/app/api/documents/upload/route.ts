import { NextResponse, type NextRequest } from 'next/server';
import { authEnv } from '@/auth/env';
import { isSameOrigin } from '@/auth/logout';
import { getAccessToken } from '@/auth/session';
import { apiBaseUrl, currentTenant } from '@/lib/api';

// Same limit as the API (apps/api documents.module.ts); only used for the early 413 below.
const MAX_BODY_BYTES = 11 * 1024 * 1024;

/**
 * Upload proxy: the browser holds no token (httpOnly cookie, ADR 0006), so it posts here and this
 * route forwards the multipart body to POST /documents/upload with the bearer token and X-Tenant.
 * The body is passed on as a stream and is never read or logged here; the API sniffs, hashes and
 * dedupes. Status and problem+json body come back unchanged.
 */
export async function POST(req: NextRequest) {
  // Cookie auth + state change: refuse cross-site posts (the session cookie is SameSite=Lax).
  if (!isSameOrigin(req.headers.get('origin'), authEnv().NEXTAUTH_URL)) {
    return NextResponse.json({ code: 'FORBIDDEN' }, { status: 403 });
  }
  const contentType = req.headers.get('content-type');
  const key = req.headers.get('idempotency-key');
  if (!req.body || !contentType?.startsWith('multipart/form-data')) {
    return NextResponse.json({ code: 'BAD_REQUEST' }, { status: 400 });
  }
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return NextResponse.json({ code: 'TOO_LARGE' }, { status: 413 });

  const [token, tenant] = await Promise.all([getAccessToken(), currentTenant()]);
  if (token === null) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': contentType,
  };
  if (tenant !== undefined) headers['x-tenant'] = tenant;
  if (key !== null) headers['idempotency-key'] = key;
  if (length > 0) headers['content-length'] = String(length);
  const traceparent = req.headers.get('traceparent');
  if (traceparent !== null) headers.traceparent = traceparent;

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/documents/upload`, {
      method: 'POST',
      headers,
      body: req.body,
      // Node's fetch needs this to send a stream; not in lib.dom's RequestInit type.
      duplex: 'half',
      cache: 'no-store',
    } as RequestInit & { duplex: 'half' });
  } catch {
    return NextResponse.json({ code: 'UPSTREAM_UNAVAILABLE' }, { status: 502 });
  }

  const out = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
  });
  const replayed = upstream.headers.get('idempotent-replayed');
  if (replayed !== null) out.set('idempotent-replayed', replayed);
  return new NextResponse(upstream.body, { status: upstream.status, headers: out });
}
