import { z } from 'zod';

/** BullMQ queue of RAG index jobs (T5.2). Separate from extraction: its failures never touch the document. */
export const INDEX_QUEUE = 'rag-index';

/** Attempts per job, the first run included (same budget as extraction). */
export const INDEX_MAX_ATTEMPTS = 5;

/**
 * One approval to index. Ids only, like extraction jobs: the worker reads the invoice itself from
 * `current_invoices`, so a job in Redis never holds content. `invoiceId` is also the job id: every
 * approval inserts a new invoice row, so an approval that rolled back after enqueueing and is then
 * sent again gets a new job instead of colliding with the finished no-op one.
 */
export const indexJobSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  documentVersion: z.number().int().min(1),
  invoiceId: z.uuid(),
});
export type IndexJobData = z.infer<typeof indexJobSchema>;

/** What a failed index job records in Redis: a code, never a message (it may hold content). */
export const INDEX_JOB_INVALID = 'INDEX_JOB_INVALID';
export const INDEX_RETRY = 'INDEX_RETRY';
export const INDEX_FAILED = 'INDEX_FAILED';
/** The AI service answered for another invoice, tenant or version than the job: never written. */
export const INDEX_RESPONSE_MISMATCH = 'INDEX_RESPONSE_MISMATCH';

/** A failure no retry can fix (the AI service refused the row, or its answer is unusable). */
export class PermanentIndexError extends Error {
  constructor(readonly code: string = INDEX_FAILED) {
    super(code);
    this.name = 'PermanentIndexError';
  }
}

/** The only error that leaves the processor; its message is always one of the codes above. */
export class IndexJobError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'IndexJobError';
  }
}
