import { NextResponse, type NextRequest } from 'next/server';
import { apiBaseUrl, upstreamHeaders } from '@/lib/api';

// Types the API can answer with (document-file.service.ts); anything else is sent as opaque bytes.
const SERVED_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain; charset=utf-8',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The original file for the review viewer (ADR 0006): the browser holds no token, so it asks here
 * and this route calls GET /documents/:id/file with the bearer token and X-Tenant, then streams
 * the answer. The body is document content: it is passed through and never read or logged. The
 * inert headers the API sets (nosniff, sandbox, no-store) are repeated, not trusted to survive.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });

  const headers = await upstreamHeaders(req.headers.get('traceparent'));
  if (headers === null) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/documents/${id}/file`, { headers, cache: 'no-store' });
  } catch {
    return NextResponse.json({ code: 'API_UNREACHABLE' }, { status: 502 });
  }

  if (upstream.ok && upstream.body !== null) {
    const type = upstream.headers.get('content-type') ?? '';
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': SERVED_TYPES.has(type) ? type : 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
      },
    });
  }

  // Pass on only the status class and our own error code, never the upstream body.
  const body = (await upstream.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === 'string' ? body.code : undefined;
  if ([401, 403, 404].includes(upstream.status)) {
    return NextResponse.json({ code }, { status: upstream.status });
  }
  return NextResponse.json({ code: 'API_ERROR' }, { status: 502 });
}
