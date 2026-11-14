/**
 * Rate limit policies (ADR 0012): one token bucket per (tenant, user, route class) and one per
 * (tenant, route class). A request takes one token from BOTH; when either is empty it is refused
 * with 429. The user bucket stops one person from flooding; the tenant bucket caps what all the
 * people of one tenant can do together, so one tenant cannot use up a quota shared by every tenant
 * (the free LLM quota behind upload and Q&A).
 */

export const RATE_LIMIT_CLASSES = ['read', 'write', 'upload', 'qa'] as const;
export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

/**
 * A bucket holds at most `capacity` tokens and gains `capacity` tokens every `windowSeconds`, one
 * at a time (refill rate = capacity / windowSeconds). A full bucket lets a burst of `capacity`
 * requests through at once; after that the steady rate is the refill rate.
 */
export interface Bucket {
  capacity: number;
  windowSeconds: number;
}

/**
 * What to do when Redis cannot answer. `open`: let the request through (a read must not stop
 * working because the limiter is down). `closed`: refuse with 503 (the request spends a shared,
 * limited resource, so no limiter means no protection).
 */
export type LimiterDownMode = 'open' | 'closed';

export interface RateLimitPolicy {
  user: Bucket;
  tenant: Bucket;
  whenLimiterDown: LimiterDownMode;
}

export const POLICIES: Readonly<Record<RateLimitClass, RateLimitPolicy>> = {
  // Every GET. The web shell asks /auth/me on each page and the list polls every 5 s while a
  // document is processing (T2.6): about 0.2 requests a second per open tab, far below 2.
  read: {
    user: { capacity: 120, windowSeconds: 60 },
    tenant: { capacity: 600, windowSeconds: 60 },
    whenLimiterDown: 'open',
  },
  // Approve, reopen, retry a failed job: cheap, and each document has its own version limit too.
  write: {
    user: { capacity: 20, windowSeconds: 60 },
    tenant: { capacity: 60, windowSeconds: 60 },
    whenLimiterDown: 'open',
  },
  // One upload is one extraction job on the LLM quota. A full user bucket still takes the
  // milestone demo's 50 files at once (M6); the queue then works through them at the provider's pace.
  upload: {
    user: { capacity: 60, windowSeconds: 60 },
    tenant: { capacity: 120, windowSeconds: 60 },
    whenLimiterDown: 'closed',
  },
  // One question costs up to 2 generate calls and 1 embed call on the free LLM quota that extraction
  // also uses (T5.4). Closed when Redis is down, Hậu's decision (2026-11-14).
  qa: {
    user: { capacity: 5, windowSeconds: 60 },
    tenant: { capacity: 20, windowSeconds: 60 },
    whenLimiterDown: 'closed',
  },
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The class of a route that does not declare one: reads are `read`, everything else `write`. */
export const defaultClassFor = (method: string): RateLimitClass =>
  READ_METHODS.has(method.toUpperCase()) ? 'read' : 'write';

/** Tokens per second, the speed at which an empty bucket fills again. */
export const refillPerSecond = (bucket: Bucket): number => bucket.capacity / bucket.windowSeconds;
