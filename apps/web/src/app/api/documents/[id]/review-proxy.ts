import { NextResponse, type NextRequest } from 'next/server';
import { authEnv } from '@/auth/env';
import { isSameOrigin } from '@/auth/logout';
import { upstreamHeaders } from '@/lib/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Answers the review screen explains to the person; anything else is an API fault. */
const PASSED_ON = new Set([400, 401, 403, 404, 409, 413, 422, 428]);

/** What the approve and reopen proxies refuse before calling the API; null when it may go on. */
export function refuseEarly(req: NextRequest, id: string): NextResponse | null {
  // Cookie auth + state change: refuse cross-site posts (the session cookie is SameSite=Lax).
  if (!isSameOrigin(req.headers.get('origin'), authEnv().NEXTAUTH_URL)) {
    return NextResponse.json({ code: 'FORBIDDEN' }, { status: 403 });
  }
  if (!UUID.test(id)) return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });
  return null;
}

/** The token, the version the person reviewed and the caller's address; null without a session. */
export async function reviewHeaders(req: NextRequest): Promise<Record<string, string> | null> {
  const headers = await upstreamHeaders(req.headers.get('traceparent'));
  if (headers === null) return null;
  const ifMatch = req.headers.get('if-match');
  if (ifMatch !== null) headers['if-match'] = ifMatch;
  // Same rule as the upload route: off unless a reverse proxy overwrites the header.
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor !== null && process.env.TRUST_FORWARDED_FOR === 'true') {
    headers['x-forwarded-for'] = forwardedFor;
  }
  return headers;
}

/** Errors pass on the status and our own code, never the upstream body. */
export async function answerFrom(upstream: Response): Promise<NextResponse> {
  if (upstream.ok) return NextResponse.json(await upstream.json(), { status: 200 });
  const body = (await upstream.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === 'string' ? body.code : undefined;
  if (PASSED_ON.has(upstream.status)) {
    return NextResponse.json({ code }, { status: upstream.status });
  }
  return NextResponse.json({ code: 'API_ERROR' }, { status: 502 });
}
