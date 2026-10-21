import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../../../config/env.schema';
import type {
  ExtractionQueuePort,
  JobState,
  RetryOutcome,
} from '../application/extraction-queue.port';
import {
  EXTRACTION_QUEUE,
  MAX_ATTEMPTS,
  extractionJobSchema,
  type ExtractionJobData,
} from '../domain/extraction-job';
import { COMMAND_TIMEOUT_MS, producerConnection, settleWithin } from './redis-connection';

const DAY_SECONDS = 24 * 3600;

/**
 * BullMQ waits for the connection to be ready before it sends a command, and that wait is not
 * covered by the connection's own command timeout. Without this bound an unreachable Redis would
 * make a request hang instead of failing, so every call to Redis goes through it.
 */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Redis timeout')), COMMAND_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class BullmqExtractionQueue implements ExtractionQueuePort, OnApplicationShutdown {
  private readonly connection: Redis;
  private readonly queue: Queue<ExtractionJobData>;

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    this.connection = producerConnection(config.get('REDIS_URL', { infer: true }));
    this.queue = new Queue<ExtractionJobData>(EXTRACTION_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        // The wait itself is computed by the worker's backoffStrategy (exponential + jitter).
        backoff: { type: 'custom' },
        removeOnComplete: { age: DAY_SECONDS, count: 1_000 },
        // Failed jobs ARE the dead-letter set: kept for a week so an admin can inspect and retry.
        removeOnFail: { age: 7 * DAY_SECONDS },
      },
    });
    this.queue.on('error', () => new Logger('ExtractionQueue').error('Redis error'));
  }

  async enqueue(data: ExtractionJobData): Promise<void> {
    const valid = extractionJobSchema.parse(data);
    await bounded(this.queue.add('extract', valid, { jobId: valid.documentId }));
  }

  async jobState(tenantId: string, documentId: string): Promise<JobState> {
    const job = await bounded(this.queue.getJob(documentId));
    // A job of another tenant is reported exactly like a missing one.
    if (!job || job.data.tenantId !== tenantId) return 'missing';
    return (await bounded(job.getState())) === 'failed' ? 'failed' : 'other';
  }

  async retryFailed(tenantId: string, documentId: string): Promise<RetryOutcome> {
    const job = await bounded(this.queue.getJob(documentId));
    if (!job || job.data.tenantId !== tenantId) return 'not_found';
    try {
      // A fresh budget: with the old counter the first transient error would fail the job again.
      await bounded(job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true }));
    } catch (e) {
      // Another admin retried it first (BullMQ: the job is no longer in the failed set).
      if (e instanceof Error && /is not in the .* state|Missing key for job/i.test(e.message))
        return 'not_failed';
      throw e;
    }
    return 'retried';
  }

  async attemptsMade(tenantId: string, documentIds: string[]): Promise<Map<string, number>> {
    const jobs = await Promise.all(documentIds.map((id) => bounded(this.queue.getJob(id))));
    const attempts = new Map<string, number>();
    for (const job of jobs) {
      if (job && job.data.tenantId === tenantId)
        attempts.set(job.data.documentId, job.attemptsMade);
    }
    return attempts;
  }

  async ping(): Promise<void> {
    await bounded(this.connection.ping());
  }

  async onApplicationShutdown(): Promise<void> {
    // close() waits for Redis; if it is gone that never ends, so give up after a moment.
    await settleWithin(COMMAND_TIMEOUT_MS, this.queue.close());
    this.connection.disconnect();
  }
}
