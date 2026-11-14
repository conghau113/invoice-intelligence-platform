import { expect } from 'vitest';

/** What the API answers over its rate limit (T6.1): a problem body we must not relay, and the wait. */
export const rateLimitedUpstream = (retryAfter = '7'): Response =>
  new Response(JSON.stringify({ code: 'RATE_LIMITED', detail: 'SAMPLE upstream text' }), {
    status: 429,
    headers: { 'content-type': 'application/problem+json', 'retry-after': retryAfter },
  });

/** A BFF route passed the 429 on: our own code, the Retry-After seconds, never the upstream body. */
export async function expectRateLimitedPassedOn(res: Response): Promise<void> {
  expect(res.status).toBe(429);
  expect(res.headers.get('retry-after')).toBe('7');
  expect(await res.json()).toEqual({ code: 'RATE_LIMITED' });
}
