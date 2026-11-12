import { isHttpErrorCode } from 'contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { authEnv } from '@/auth/env';
import { isSameOrigin } from '@/auth/logout';
import { apiBaseUrl, upstreamHeaders } from '@/lib/api';
import { bffError } from '@/lib/bff-error';

/** The question is at most 1,000 characters (QaAskBodySchema): 16 KiB is plenty, even escaped. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * The longest one question may take, from sending it to the last event. The API decides the whole
 * answer before it writes its first byte (T5.4: two model steps of up to 30 s each, plus
 * retrieval), so this must stay well above 60 s; past it the person gets a clear error instead of
 * a page that waits forever.
 */
const UPSTREAM_TIMEOUT_MS = 90_000;

/** Answers the Q&A screen explains with its own code; anything else is an API fault. 429 is T6.1. */
const PASSED_ON = new Set([400, 401, 403, 404, 413, 429, 503]);

/**
 * Q&A proxy (ADR 0006: the browser holds no token). The question goes up as it came, the answer
 * comes back as Server-Sent Events, passed through as a stream: never read, buffered or logged,
 * since it holds invoice content and model text.
 *
 * Cancelling: when the browser closes the connection (stop button, page left), `req.signal` aborts
 * the upstream fetch, the API sees its connection close and stops waiting on the model (T5.4).
 */
export async function POST(req: NextRequest) {
  // Cookie auth + a request that spends model quota: refuse cross-site posts.
  if (!isSameOrigin(req.headers.get('origin'), authEnv().NEXTAUTH_URL)) {
    return bffError('FORBIDDEN', 403);
  }
  if (!req.body || !req.headers.get('content-type')?.startsWith('application/json')) {
    return bffError('BAD_REQUEST', 400);
  }
  // The browser always sends a length for a JSON string body. Without one (chunked) or with a
  // malformed one, the size cannot be known up front: refuse rather than stream an unknown amount
  // to the API. Node's HTTP parser cuts the body at the declared length, so it cannot lie upward.
  const length = Number(req.headers.get('content-length') ?? Number.NaN);
  if (!Number.isSafeInteger(length) || length < 0) return bffError('BAD_REQUEST', 400);
  if (length > MAX_BODY_BYTES) return bffError('TOO_LARGE', 413);

  const headers = await upstreamHeaders(req.headers.get('traceparent'));
  if (headers === null) return bffError('UNAUTHENTICATED', 401);
  headers['content-type'] = 'application/json';
  headers.accept = 'text/event-stream';

  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/qa/ask`, {
      method: 'POST',
      headers,
      body: req.body,
      // Node's fetch needs this to send a stream; not in lib.dom's RequestInit type.
      duplex: 'half',
      cache: 'no-store',
      signal: AbortSignal.any([req.signal, timeout]),
    } as RequestInit & { duplex: 'half' });
  } catch {
    if (timeout.aborted) return bffError('UPSTREAM_UNAVAILABLE', 504);
    // The browser left: nobody reads this answer.
    return bffError('API_UNREACHABLE', 502);
  }

  const type = upstream.headers.get('content-type') ?? '';
  if (upstream.ok && upstream.body !== null && type.startsWith('text/event-stream')) {
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        // no-transform: Next's own compression (and a proxy's) would buffer the events.
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (upstream.ok) return bffError('API_ERROR', 502);

  // Pass on the status and our own code, never the upstream body.
  const body = (await upstream.json().catch(() => ({}))) as { code?: unknown };
  // Only a code from the shared list goes on; the screen translates nothing else anyway.
  const code = isHttpErrorCode(body.code) ? body.code : undefined;
  if (PASSED_ON.has(upstream.status)) {
    return NextResponse.json({ code }, { status: upstream.status });
  }
  return bffError('API_ERROR', 502);
}
