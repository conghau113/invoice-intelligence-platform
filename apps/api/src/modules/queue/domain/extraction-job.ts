import type { DocumentFailureCode } from 'contracts';

import { z } from 'zod';

export const EXTRACTION_QUEUE = 'extraction';

/** Attempts per job, the first run included (spec T2.4). */
export const MAX_ATTEMPTS = 5;

/** Upper bound of one wait, so a late attempt never sleeps for hours. */
export const MAX_BACKOFF_MS = 5 * 60_000;

/** W3C Trace Context `traceparent`: version-traceid-spanid-flags, all-zero ids are invalid. */
const TRACEPARENT = /^[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * Everything a job carries. Ids only: the file stays in storage and the worker reads it by the
 * document's own record, so a job in Redis never holds content or PII. `.strict()` makes an extra
 * field a parse error instead of silently riding along.
 */
export const extractionJobSchema = z.strictObject({
  documentId: z.uuid(),
  tenantId: z.uuid(),
  traceparent: z.string().regex(TRACEPARENT).optional(),
});
export type ExtractionJobData = z.infer<typeof extractionJobSchema>;

/** A request header is user input: keep it only when it is a well-formed traceparent. */
export function parseTraceparent(header: unknown): string | undefined {
  return typeof header === 'string' && TRACEPARENT.test(header) ? header : undefined;
}

/**
 * Wait before the next attempt: exponential growth (base * 2^(n-1), capped) with "full jitter",
 * a random point anywhere between 0 and that ceiling (T6.2). Jobs that failed together (the AI
 * service was down) would otherwise all come back in the same instant and knock it over again
 * (thundering herd); spread over the whole range, they arrive one by one. Compared with keeping a
 * fixed half ("equal jitter"), full jitter spreads more and finishes the work sooner overall; a
 * job may retry almost at once, which is fine because the queue limiter still paces the starts.
 * `attemptsMade` counts the attempts that already failed, so the first retry has attemptsMade = 1.
 */
export function backoffMs(
  attemptsMade: number,
  baseMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attemptsMade - 1);
  const ceiling = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
}

/** What the worker records when a job ends or is retried: a code, never a message (may hold content). */
export const EXTRACTION_RETRY = 'EXTRACTION_RETRY';
/** The provider was over its rate limit: the job went back to the queue without using an attempt. */
export const EXTRACTION_RATE_LIMITED = 'EXTRACTION_RATE_LIMITED';
export const EXTRACTION_FAILED = 'EXTRACTION_FAILED' satisfies DocumentFailureCode;
export const EXTRACTION_RETRIES_EXHAUSTED =
  'EXTRACTION_RETRIES_EXHAUSTED' satisfies DocumentFailureCode;
export const EXTRACTION_STALLED = 'EXTRACTION_STALLED' satisfies DocumentFailureCode;
export const MANUAL_RETRY = 'MANUAL_RETRY';
/** Admin retry found the job failed in the queue while the document was still `processing`. */
export const JOB_FAILED_IN_QUEUE = 'JOB_FAILED_IN_QUEUE';

/**
 * Handlers throw this for an error no retry can fix (the file is not an invoice, the schema is
 * wrong): the job fails at once instead of burning 5 attempts. Any other error is retried.
 */
export class PermanentExtractionError extends Error {
  constructor(readonly code: DocumentFailureCode = EXTRACTION_FAILED) {
    super(code);
    this.name = 'PermanentExtractionError';
  }
}

/**
 * Handlers throw this for a failure a later attempt may fix (a service that is down, a setting an
 * operator can correct). The job is retried; if the attempts run out, the document fails with this
 * `code` instead of the generic EXTRACTION_RETRIES_EXHAUSTED, so the reason survives. Any other
 * non-permanent error behaves like this one with the generic code.
 */
export class TransientExtractionError extends Error {
  constructor(
    readonly code: DocumentFailureCode = EXTRACTION_RETRIES_EXHAUSTED,
    /** The wait the AI service passed on from the provider's 429 (Retry-After), if any. */
    readonly retryAfterMs?: number,
    /**
     * The provider is over its rate limit (busy, not broken): the AI service said LLM_RATE_LIMITED,
     * or answered 429. A Retry-After alone does not make it one: a proxy sends it with a 503 too.
     */
    readonly rateLimited: boolean = code === 'LLM_RATE_LIMITED',
  ) {
    super(code);
    this.name = 'TransientExtractionError';
  }
}

/**
 * The only error that leaves the processor. Its message is always one of the codes above, so
 * BullMQ's `failedReason` (stored in Redis, shown to admins) cannot leak what a handler said.
 */
export class ExtractionJobError extends Error {
  constructor(
    readonly code: string,
    /** False: do not retry (BullMQ `UnrecoverableError`). */
    readonly retryable: boolean,
    readonly options: {
      /** The provider is over its limit: hold the queue this long, keep the job's attempts (T6.2). */
      deferMs?: number;
      /** Over its limit, but the job has waited enough: hold the queue, the attempt is used. */
      holdMs?: number;
      /** The AI service or the provider could not answer: counts towards the circuit breaker. */
      providerDown?: boolean;
    } = {},
  ) {
    super(code);
    this.name = 'ExtractionJobError';
  }
}
