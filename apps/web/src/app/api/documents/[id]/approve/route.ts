import { NextResponse, type NextRequest } from 'next/server';
import { authEnv } from '@/auth/env';
import { isSameOrigin } from '@/auth/logout';
import { apiBaseUrl, upstreamHeaders } from '@/lib/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Answers the form explains to the person; anything else is an API fault. */
const PASSED_ON = new Set([400, 401, 403, 404, 409, 413, 422, 428]);

// Same limit as the API (apps/api json-body-limit.ts); only used for the early 413 below.
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Approve proxy: the browser holds no token (ADR 0006). The body is the corrected invoice, which is
 * document content: it goes through as a stream, unread and unlogged, and the API validates it.
 * `If-Match` carries the version the person reviewed. Errors pass on the status and our own code,
 * never the upstream body.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // Cookie auth + state change: refuse cross-site posts (the session cookie is SameSite=Lax).
  if (!isSameOrigin(req.headers.get('origin'), authEnv().NEXTAUTH_URL)) {
    return NextResponse.json({ code: 'FORBIDDEN' }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });
  if (!req.body || !req.headers.get('content-type')?.startsWith('application/json')) {
    return NextResponse.json({ code: 'BAD_REQUEST' }, { status: 400 });
  }
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ code: 'BODY_TOO_LARGE' }, { status: 413 });
  }

  const headers = await upstreamHeaders(req.headers.get('traceparent'));
  if (headers === null) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  headers['content-type'] = 'application/json';
  const ifMatch = req.headers.get('if-match');
  if (ifMatch !== null) headers['if-match'] = ifMatch;
  // Same rule as the upload route: off unless a reverse proxy overwrites the header.
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor !== null && process.env.TRUST_FORWARDED_FOR === 'true') {
    headers['x-forwarded-for'] = forwardedFor;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/documents/${id}/approve`, {
      method: 'POST',
      headers,
      body: req.body,
      // Node's fetch needs this to send a stream; not in lib.dom's RequestInit type.
      duplex: 'half',
      cache: 'no-store',
    } as RequestInit & { duplex: 'half' });
  } catch {
    return NextResponse.json({ code: 'API_UNREACHABLE' }, { status: 502 });
  }
  if (upstream.ok) return NextResponse.json(await upstream.json(), { status: 200 });

  const body = (await upstream.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === 'string' ? body.code : undefined;
  if (PASSED_ON.has(upstream.status))
    return NextResponse.json({ code }, { status: upstream.status });
  return NextResponse.json({ code: 'API_ERROR' }, { status: 502 });
}
