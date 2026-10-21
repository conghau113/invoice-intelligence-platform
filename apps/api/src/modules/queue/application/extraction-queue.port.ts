import type { ExtractionJobData } from '../domain/extraction-job';

export const EXTRACTION_QUEUE_PORT = Symbol('EXTRACTION_QUEUE_PORT');

/** A document whose extraction failed. `reason` is a code, never a message. */
export interface FailedJobView {
  documentId: string;
  /** Null when the job is gone from Redis or Redis cannot be reached. */
  attemptsMade: number | null;
  reason: string | null;
  failedAt: Date;
}

/** `other`: waiting, running, delayed or completed. `missing`: no such job (expired, flushed, or another tenant's). */
export type JobState = 'failed' | 'other' | 'missing';

export type RetryOutcome = 'retried' | 'not_found' | 'not_failed';

/**
 * What the API needs from the queue. The BullMQ adapter implements it; unit tests use a fake, so
 * no business rule depends on Redis being there. Every method throws when Redis is unreachable;
 * callers map that to 503.
 */
export interface ExtractionQueuePort {
  /** One job per document: the job id IS the document id, so adding it twice is a no-op. */
  enqueue(data: ExtractionJobData): Promise<void>;
  /** The queue is shared by all tenants: a job of another tenant is reported as `missing`. */
  jobState(tenantId: string, documentId: string): Promise<JobState>;
  /** Re-runs a failed job with a fresh set of attempts. */
  retryFailed(tenantId: string, documentId: string): Promise<RetryOutcome>;
  /** Attempts used per document, only for jobs of this tenant that still exist. */
  attemptsMade(tenantId: string, documentIds: string[]): Promise<Map<string, number>>;
  ping(): Promise<void>;
}
