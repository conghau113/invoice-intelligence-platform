import type { Bucket } from '../domain/policies';

export const RATE_LIMITER = Symbol('RATE_LIMITER');

/** The state of one bucket after a take, in whole numbers a client can be told. */
export interface BucketState {
  /** Whole tokens left (rounded down). */
  remaining: number;
  /** Milliseconds until the bucket is full again; 0 when it is full. */
  fullInMs: number;
}

export interface TakeResult {
  /** True when a token was taken from BOTH buckets; false means neither was touched. */
  allowed: boolean;
  /** When refused: milliseconds until both buckets hold enough tokens. 0 when allowed. */
  retryAfterMs: number;
  user: BucketState;
  tenant: BucketState;
}

export interface TakeRequest {
  /** Redis key of the user's bucket and of the tenant's bucket (see bucketKeys). */
  userKey: string;
  tenantKey: string;
  user: Bucket;
  tenant: Bucket;
}

/**
 * Takes one token from two buckets as one step: either both lose a token or neither does. Two
 * requests at the same moment must never both see the last token, on one API instance or many.
 */
export interface RateLimiterPort {
  take(request: TakeRequest): Promise<TakeResult>;
}

/** The limiter could not answer (Redis down, slow or refused the script). Carries no Redis detail. */
export class RateLimiterUnavailableError extends Error {
  constructor() {
    super('Rate limiter unavailable');
    this.name = 'RateLimiterUnavailableError';
  }
}
