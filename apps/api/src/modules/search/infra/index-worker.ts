import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../../../config/env.schema';
import { backoffMs } from '../../queue/domain/extraction-job';
import { settleWithin, workerConnection } from '../../queue/infra/redis-connection';
import { IndexProcessor } from '../application/index.processor';
import { INDEX_FAILED, INDEX_MAX_ATTEMPTS, INDEX_QUEUE, IndexJobError } from '../domain/index-job';

/** Index jobs handled at the same time: one embedding call each, kept low for the free-tier RPM. */
const CONCURRENCY = 1;
const SHUTDOWN_GRACE_MS = 30_000;

/** Adapter between BullMQ and IndexProcessor, run only by the worker process (src/worker.ts). */
@Injectable()
export class IndexWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(IndexWorker.name);
  private connection?: Redis;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly processor: IndexProcessor,
  ) {}

  onApplicationBootstrap(): void {
    const baseMs = this.config.get('QUEUE_BACKOFF_BASE_MS', { infer: true });
    this.connection = workerConnection(this.config.get('REDIS_URL', { infer: true }));
    this.worker = new Worker(INDEX_QUEUE, (job) => this.handle(job), {
      connection: this.connection,
      concurrency: CONCURRENCY,
      maxStalledCount: 1,
      settings: { backoffStrategy: (attemptsMade) => backoffMs(attemptsMade, baseMs) },
    });
    // Ids only: a job's data and error text never go to the log.
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`index job ${job?.id ?? '?'} failed (${err.message})`),
    );
    this.worker.on('error', (err) => this.logger.error(`index worker error (${err.name})`));
  }

  private async handle(job: Job): Promise<void> {
    try {
      await this.processor.process(job.data, {
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts ?? INDEX_MAX_ATTEMPTS,
      });
    } catch (e) {
      const queueError = toQueueError(e);
      // Only for errors that are not ours: the class and, for Postgres, the SQLSTATE. Never the
      // message or detail, which can quote the row (document content).
      if (!(e instanceof IndexJobError)) {
        this.logger.warn(`index job ${job.id ?? '?'} error (${causeOf(e)})`);
      }
      throw queueError;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.worker) return;
    await settleWithin(SHUTDOWN_GRACE_MS, this.worker.close());
    this.connection?.disconnect();
    await settleWithin(SHUTDOWN_GRACE_MS, this.worker.close(true));
  }
}

/**
 * What BullMQ gets for an error of the processor. Its message is stored in Redis and shown to
 * admins, so it is always one of our codes: a non-retryable IndexJobError becomes
 * UnrecoverableError (no more attempts), a retryable one is retried, and anything else (the
 * database is down, a constraint failed) is retried as INDEX_FAILED.
 */
export function toQueueError(e: unknown): Error {
  if (e instanceof IndexJobError && !e.retryable) return new UnrecoverableError(e.code);
  if (e instanceof IndexJobError) return e;
  return new Error(INDEX_FAILED);
}

/** SQLSTATE: five upper-case letters or digits. Anything else is not a Postgres code. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** A loggable cause: the error class, plus the SQLSTATE of a Postgres error. Never a message. */
export function causeOf(e: unknown): string {
  if (!(e instanceof Error)) return 'unknown';
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && SQLSTATE.test(code) ? `${e.name}/${code}` : e.name;
}
