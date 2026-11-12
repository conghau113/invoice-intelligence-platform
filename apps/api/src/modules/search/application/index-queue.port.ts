import type { IndexJobData } from '../domain/index-job';

export const INDEX_QUEUE_PORT = Symbol('INDEX_QUEUE_PORT');

/** What approval needs from the index queue. Throws when Redis is unreachable; callers answer 503. */
export interface IndexQueuePort {
  /** One job per approval (job id = invoice id), so adding it twice is a no-op. */
  enqueue(data: IndexJobData): Promise<void>;
}
