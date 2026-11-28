import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../../../config/env.schema';
import { STATS_KEY } from '../../cache/domain/cache-keys';
import { bounded } from '../../queue/infra/bullmq-extraction-queue';
import { EXTRACTION_QUEUE } from '../../queue/domain/extraction-job';
import {
  COMMAND_TIMEOUT_MS,
  producerConnection,
  settleWithin,
} from '../../queue/infra/redis-connection';
import { INDEX_QUEUE } from '../../search/domain/index-job';
import type { MetricsSource, QueueSnapshot } from '../application/operational-metrics';

const QUEUES = [EXTRACTION_QUEUE, INDEX_QUEUE];

/**
 * Reads the queues and the cache counters, read-only. The connection is opened on the first read:
 * with metrics off no collection ever happens, so the API opens no extra connection. Every command
 * is bounded, so a dead Redis costs one export round at most the command timeout.
 */
@Injectable()
export class RedisMetricsSource implements MetricsSource, OnApplicationShutdown {
  private readonly url: string;
  private connection: Redis | undefined;
  private queuesByName: Queue[] = [];
  /**
   * Set on shutdown. Metrics stop after this provider (TracingModule is global, so last) and
   * collect one final time: without the flag that read would open a new connection that nothing
   * closes, and the process would not exit. Reads then resolve to null (nothing to report), not an
   * error, which would show as Redis unreachable on every restart (code review T7.3).
   */
  private closed = false;

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    this.url = config.get('REDIS_URL', { infer: true });
  }

  private open(): { redis: Redis; queues: Queue[] } {
    if (this.connection === undefined) {
      this.connection = producerConnection(this.url);
      const connection = this.connection;
      // Errors surface through the bounded commands; the listener only stops an unhandled event.
      this.queuesByName = QUEUES.map((name) =>
        new Queue(name, { connection }).on('error', () => {}),
      );
    }
    return { redis: this.connection, queues: this.queuesByName };
  }

  async queues(): Promise<QueueSnapshot[] | null> {
    if (this.closed) return null;
    const { queues } = this.open();
    return Promise.all(
      queues.map(async (queue) => {
        const counts = await bounded(queue.getJobCounts('waiting', 'active', 'delayed', 'failed'));
        // Ascending: the job a worker would take next.
        const [head] = await bounded(queue.getJobs(['waiting'], 0, 0, true));
        return {
          queue: queue.name,
          counts: {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
          },
          headJobId: head?.id ?? null,
        };
      }),
    );
  }

  async cacheCounters(): Promise<Record<string, string> | null> {
    if (this.closed) return null;
    return bounded(this.open().redis.hgetall(STATS_KEY));
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    const connection = this.connection;
    if (connection === undefined) return;
    this.connection = undefined;
    await settleWithin(
      COMMAND_TIMEOUT_MS,
      Promise.all(this.queuesByName.map((q) => q.close())).then(() => connection.quit()),
    );
    connection.disconnect();
  }
}
