import type { ExtractionJobData } from '../domain/extraction-job';

export const EXTRACTION_HANDLER = Symbol('EXTRACTION_HANDLER');

/**
 * The work of one attempt (T2.9: read the file, call the AI service, store the extraction).
 * Contract: throw `PermanentExtractionError` when retrying cannot help; any other error is treated
 * as transient. It must be idempotent, because the queue delivers at least once: after a crash
 * the same job can run again.
 */
export interface ExtractionHandler {
  extract(job: ExtractionJobData): Promise<void>;
}
