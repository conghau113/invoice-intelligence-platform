import type { IndexQueuePort } from '../application/index-queue.port';
import type { IndexJobData } from '../domain/index-job';

/** In-memory index queue with the BullMQ adapter's rule (one job per invoice id). */
export class FakeIndexQueue implements IndexQueuePort {
  readonly jobs = new Map<string, IndexJobData>();
  down = false;

  enqueue(data: IndexJobData): Promise<void> {
    if (this.down) return Promise.reject(new Error('Redis is down'));
    if (!this.jobs.has(data.invoiceId)) this.jobs.set(data.invoiceId, data);
    return Promise.resolve();
  }
}
