import { NextResponse, type NextRequest } from 'next/server';
import { apiBaseUrl } from '@/lib/api';
import { answerFrom, refuseEarly, reviewHeaders } from '../review-proxy';

// Same limit as the API (apps/api json-body-limit.ts); only used for the early 413 below.
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Approve proxy: the browser holds no token (ADR 0006). The body is the corrected invoice, which is
 * document content: it goes through as a stream, unread and unlogged, and the API validates it.
 * `If-Match` carries the version the person reviewed.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const refused = refuseEarly(req, id);
  if (refused !== null) return refused;
  if (!req.body || !req.headers.get('content-type')?.startsWith('application/json')) {
    return NextResponse.json({ code: 'BAD_REQUEST' }, { status: 400 });
  }
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ code: 'BODY_TOO_LARGE' }, { status: 413 });
  }

  const headers = await reviewHeaders(req);
  if (headers === null) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  headers['content-type'] = 'application/json';

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
  return answerFrom(upstream);
}
