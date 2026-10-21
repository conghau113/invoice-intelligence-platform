import type {
  ExtractionQueuePort,
  JobState,
  RetryOutcome,
} from '../application/extraction-queue.port';
import type { ExtractionJobData } from '../domain/extraction-job';

/**
 * In-memory queue with the same rules as the BullMQ adapter (one job per document id), for tests
 * of code that enqueues. `down` makes every call fail the way an unreachable Redis does.
 */
export class FakeExtractionQueue implements ExtractionQueuePort {
  readonly jobs = new Map<string, ExtractionJobData>();
  /** Document ids whose job is in the failed set, with the attempts they used. */
  readonly failed = new Map<string, number>();
  down = false;

  private guard(): Promise<void> {
    return this.down ? Promise.reject(new Error('Redis is down')) : Promise.resolve();
  }

  async enqueue(data: ExtractionJobData): Promise<void> {
    await this.guard();
    if (!this.jobs.has(data.documentId)) this.jobs.set(data.documentId, data);
  }

  async jobState(tenantId: string, documentId: string): Promise<JobState> {
    await this.guard();
    const job = this.jobs.get(documentId);
    if (!job || job.tenantId !== tenantId) return 'missing';
    return this.failed.has(documentId) ? 'failed' : 'other';
  }

  async retryFailed(tenantId: string, documentId: string): Promise<RetryOutcome> {
    await this.guard();
    const job = this.jobs.get(documentId);
    if (!job || job.tenantId !== tenantId) return 'not_found';
    if (!this.failed.delete(documentId)) return 'not_failed';
    return 'retried';
  }

  async attemptsMade(tenantId: string, ids: string[]): Promise<Map<string, number>> {
    await this.guard();
    const out = new Map<string, number>();
    for (const id of ids) {
      if (this.jobs.get(id)?.tenantId === tenantId) out.set(id, this.failed.get(id) ?? 0);
    }
    return out;
  }

  ping(): Promise<void> {
    return this.guard();
  }
}
