import { NextResponse, type NextRequest } from 'next/server';
import { apiBaseUrl } from '@/lib/api';
import { answerFrom, refuseEarly, reviewHeaders } from '../review-proxy';

/**
 * Reopen proxy: the browser holds no token (ADR 0006). No body; `If-Match` carries the version the
 * person was looking at, and the API compares it.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const refused = refuseEarly(req, id);
  if (refused !== null) return refused;

  const headers = await reviewHeaders(req);
  if (headers === null) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/documents/${id}/reopen`, {
      method: 'POST',
      headers,
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ code: 'API_UNREACHABLE' }, { status: 502 });
  }
  return answerFrom(upstream);
}
