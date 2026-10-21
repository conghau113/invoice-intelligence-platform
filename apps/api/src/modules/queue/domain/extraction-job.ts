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
 * Wait before the next attempt: exponential growth (base * 2^(n-1), capped) with "equal jitter",
 * half fixed and half random. The fixed half keeps a minimum gap; the random half spreads jobs
 * that failed together (e.g. the AI service was down) so they do not all retry in the same second.
 * `attemptsMade` counts the attempts that already failed, so the first retry has attemptsMade = 1.
 */
export function backoffMs(
  attemptsMade: number,
  baseMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attemptsMade - 1);
  const ceiling = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** exponent);
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

/** What the worker records when a job ends or is retried: a code, never a message (may hold content). */
export const EXTRACTION_RETRY = 'EXTRACTION_RETRY';
export const EXTRACTION_FAILED = 'EXTRACTION_FAILED';
export const EXTRACTION_RETRIES_EXHAUSTED = 'EXTRACTION_RETRIES_EXHAUSTED';
export const EXTRACTION_STALLED = 'EXTRACTION_STALLED';
export const MANUAL_RETRY = 'MANUAL_RETRY';
/** Admin retry found the job failed in the queue while the document was still `processing`. */
export const JOB_FAILED_IN_QUEUE = 'JOB_FAILED_IN_QUEUE';

/**
 * Handlers throw this for an error no retry can fix (the file is not an invoice, the schema is
 * wrong): the job fails at once instead of burning 5 attempts. Any other error is retried.
 */
export class PermanentExtractionError extends Error {
  constructor(readonly code: string = EXTRACTION_FAILED) {
    super(code);
    this.name = 'PermanentExtractionError';
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
  ) {
    super(code);
    this.name = 'ExtractionJobError';
  }
}
