import type { HttpErrorCode } from 'contracts';
import { NextResponse } from 'next/server';

/** A failed answer from one of the web's own route handlers. The body is only a listed code. */
export const bffError = (code: HttpErrorCode, status: number): NextResponse =>
  NextResponse.json({ code }, { status });

/** `Retry-After` in seconds, the only form the API sends (rate-limit.guard.ts). */
const RETRY_AFTER_SECONDS = /^\d{1,6}$/;

/**
 * The API's 429 (T6.1), passed on as our own body plus the one header the client needs: how long
 * to wait. A `Retry-After` in any other shape (an HTTP date, or anything odd) is dropped, not relayed.
 * `null` when the upstream answer is not a 429.
 */
export function rateLimited(upstream: Response): NextResponse | null {
  if (upstream.status !== 429) return null;
  const res = bffError('RATE_LIMITED', 429);
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter !== null && RETRY_AFTER_SECONDS.test(retryAfter)) {
    res.headers.set('retry-after', retryAfter);
  }
  return res;
}
