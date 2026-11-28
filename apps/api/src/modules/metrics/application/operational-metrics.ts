import type { BatchObservableResult, Meter } from '@opentelemetry/api';
import type { CacheOutcome } from '../../cache/application/cache-store.port';
import { EXTRACTION_CACHE, GENERATION, READ_CACHES } from '../../cache/domain/cache-keys';

/**
 * Gauges read from Redis at each metric export (T7.3): how many jobs each queue holds, how long the
 * job at the head of each queue has gone without being taken, and the cache hit/miss counters
 * (Phát sinh T6.3). Read by the API process, not the worker: a dead worker is exactly when the
 * queue grows, and the reading must survive it. Labels are fixed sets (queue name, state, cache
 * name, outcome); nothing per tenant or per job.
 */

/**
 * BullMQ 6 has no separate paused list: a paused queue (an admin's `pause()`) and a worker held by
 * the provider guard (T6.2, `RateLimitError`) both leave jobs in `waiting`, so the head age sees them.
 */
export const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

export interface QueueSnapshot {
  queue: string;
  counts: Record<QueueState, number>;
  /** Id of the job a worker would take next; null when nothing waits. */
  headJobId: string | null;
}

/** Both reads resolve to null once the source is shut down: nothing is observed then. */
export interface MetricsSource {
  queues(): Promise<QueueSnapshot[] | null>;
  /** The raw `cache:stats` hash: `<cache>:<outcome>` → count. */
  cacheCounters(): Promise<Record<string, string> | null>;
}

export const METRICS_SOURCE = Symbol('METRICS_SOURCE');

const CACHE_NAMES = new Set<string>([...READ_CACHES, EXTRACTION_CACHE, GENERATION]);
const CACHE_OUTCOMES = new Set<string>([
  'hit',
  'miss',
  'coalesced',
  'error',
  'skipped',
] satisfies CacheOutcome[]);

/** Only known cache names and outcomes become labels: the hash is shared and could hold anything. */
export function parseCacheCounters(
  hash: Record<string, string>,
): { cache: string; outcome: string; count: number }[] {
  const out: { cache: string; outcome: string; count: number }[] = [];
  for (const [field, raw] of Object.entries(hash)) {
    const cut = field.lastIndexOf(':');
    const cache = field.slice(0, cut);
    const outcome = field.slice(cut + 1);
    const count = Number(raw);
    if (cut <= 0 || !CACHE_NAMES.has(cache) || !CACHE_OUTCOMES.has(outcome)) continue;
    if (!Number.isSafeInteger(count) || count < 0) continue;
    out.push({ cache, outcome, count });
  }
  return out;
}

/**
 * How long the head of each queue has stayed the same job, as seen by this process. A job's own
 * timestamps cannot say this: BullMQ keeps the creation time when an admin retries a failed job or
 * a backoff puts it back, so a week-old job retried now would look a week stuck (code review T7.3).
 * The clock starts when this process first sees a job at the head, so after an API restart an alert
 * comes up to one threshold later; a job id that leaves and comes back between two reads (under a
 * minute) counts as never having moved.
 */
export class QueueHeads {
  private readonly heads = new Map<string, { id: string; since: number }>();

  /** Age in ms of `headJobId` at the head of `queue`; 0 when nothing waits or the head moved. */
  seen(queue: string, headJobId: string | null, now: number): number {
    if (headJobId === null) {
      this.heads.delete(queue);
      return 0;
    }
    const current = this.heads.get(queue);
    if (current?.id !== headJobId) {
      this.heads.set(queue, { id: headJobId, since: now });
      return 0;
    }
    return now - current.since;
  }

  /** Redis unreadable: the heads are assumed not to have moved, so their ages keep growing. */
  unread(now: number): { queue: string; ageMs: number }[] {
    return [...this.heads].map(([queue, head]) => ({ queue, ageMs: now - head.since }));
  }
}

/**
 * Registers the instruments on `meter`. The callback runs only when a metric reader collects (every
 * export interval), so with metrics off nothing ever reads Redis.
 *
 * A read that fails (Redis down): `queue.reachable` is 0, the head ages keep growing from what was
 * last seen (a stuck job still alerts), and job counts are not observed, so with cumulative export
 * the SDK repeats their last values (checked in metrics.int-spec.ts). A source that is shut down
 * observes nothing at all: the last export on exit must not report Redis as unreachable.
 */
export function registerOperationalMetrics(
  meter: Meter,
  source: MetricsSource,
  now: () => number = Date.now,
): void {
  const jobs = meter.createObservableGauge('queue.jobs', {
    description: 'Jobs in a BullMQ queue, by state.',
    unit: '{job}',
  });
  const headAge = meter.createObservableGauge('queue.head_wait.age', {
    description: 'How long the next job of the queue has been next without a worker taking it.',
    unit: 's',
  });
  const reachable = meter.createObservableGauge('queue.reachable', {
    description: '1 when this round read the queues from Redis, 0 when the read failed.',
  });
  const cache = meter.createObservableCounter('cache.requests', {
    description: 'Cache lookups by cache and outcome (all API and worker processes).',
    unit: '{request}',
  });
  const heads = new QueueHeads();

  meter.addBatchObservableCallback(
    async (result: BatchObservableResult) => {
      const [queues, counters] = await Promise.allSettled([
        source.queues(),
        source.cacheCounters(),
      ]);
      const at = now();
      if (queues.status === 'rejected') {
        result.observe(reachable, 0);
        for (const h of heads.unread(at)) {
          result.observe(headAge, h.ageMs / 1000, { queue: h.queue });
        }
      } else if (queues.value !== null) {
        result.observe(reachable, 1);
        for (const q of queues.value) {
          for (const state of QUEUE_STATES) {
            result.observe(jobs, q.counts[state], { queue: q.queue, state });
          }
          result.observe(headAge, heads.seen(q.queue, q.headJobId, at) / 1000, { queue: q.queue });
        }
      }
      if (counters.status === 'fulfilled' && counters.value !== null) {
        for (const c of parseCacheCounters(counters.value)) {
          result.observe(cache, c.count, { cache: c.cache, outcome: c.outcome });
        }
      }
    },
    [jobs, headAge, reachable, cache],
  );
}
