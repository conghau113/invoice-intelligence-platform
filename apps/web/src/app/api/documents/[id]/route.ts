import { NextResponse, type NextRequest } from 'next/server';
import { apiBaseUrl, upstreamHeaders } from '@/lib/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Detail proxy (same idea as the list route): the browser holds no token (ADR 0006), so the page
 * asks here and this route calls GET /documents/:id with the bearer token and X-Tenant. The id is
 * checked as a uuid before it goes into a URL, so nothing else can be appended to the path. The
 * extracted invoice is document content: it is passed through to the caller and never logged.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });

  const headers = await upstreamHeaders(req.headers.get('traceparent'));
  if (headers === null) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/documents/${id}`, { headers, cache: 'no-store' });
  } catch {
    return NextResponse.json({ code: 'API_UNREACHABLE' }, { status: 502 });
  }
  if (upstream.ok) return NextResponse.json(await upstream.json(), { status: 200 });

  // Pass on only the status class and our own error code, never the upstream body.
  const body = (await upstream.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === 'string' ? body.code : undefined;
  if ([401, 403, 404].includes(upstream.status)) {
    return NextResponse.json({ code }, { status: upstream.status });
  }
  return NextResponse.json({ code: 'API_ERROR' }, { status: 502 });
}
