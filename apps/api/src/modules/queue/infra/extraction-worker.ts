import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { withJobLogContext } from '../../../common/logging/job-log-context';
import { runInConsumerSpan } from '../../../common/otel/trace-context';
import type { Env } from '../../../config/env.schema';
import { EXTRACTION_TOKENS_PER_JOB } from '../../extraction/resilience';
import { ExtractionProcessor } from '../application/extraction.processor';
import {
  EXTRACTION_FAILED,
  EXTRACTION_RETRIES_EXHAUSTED,
  EXTRACTION_STALLED,
  EXTRACTION_QUEUE,
  ExtractionJobError,
  MAX_ATTEMPTS,
  backoffMs,
} from '../domain/extraction-job';
import { ProviderGuard, isRateLimitError } from './provider-guard';
import { settleWithin, workerConnection } from './redis-connection';

/** Documents handled at the same time by one worker process. */
const CONCURRENCY = 2;

/** How long shutdown waits for running jobs before closing the worker forcibly. */
const SHUTDOWN_GRACE_MS = 30_000;

/**
 * Adapter between BullMQ and ExtractionProcessor, run only by the worker process (src/worker.ts).
 * Retry timing lives here (BullMQ asks `backoffStrategy` how long to wait); what a failed attempt
 * does to the document lives in the processor.
 */
@Injectable()
export class ExtractionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExtractionWorker.name);
  private connection?: Redis;
  private worker?: Worker;
  /** Pace, circuit breaker, and holding the whole queue when the provider says wait (T6.2). */
  private guard?: ProviderGuard;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly processor: ExtractionProcessor,
  ) {}

  onApplicationBootstrap(): void {
    const baseMs = this.config.get('QUEUE_BACKOFF_BASE_MS', { infer: true });
    this.connection = workerConnection(this.config.get('REDIS_URL', { infer: true }));
    // Starts are spaced so that no minute holds more jobs than the provider plan allows (T6.2).
    const { guard, limiter } = ProviderGuard.forQueue(
      EXTRACTION_QUEUE,
      this.connection,
      this.config,
      { rpm: 'LLM_RPM', tpm: 'LLM_TPM', tokensPerJob: EXTRACTION_TOKENS_PER_JOB },
      this.logger,
    );
    this.guard = guard;
    this.worker = new Worker(EXTRACTION_QUEUE, (job) => this.handle(job), {
      connection: this.connection,
      concurrency: CONCURRENCY,
      limiter,
      // A job whose worker died is given back once; a second stall fails it (see reconcile).
      maxStalledCount: 1,
      settings: { backoffStrategy: (attemptsMade) => backoffMs(attemptsMade, baseMs) },
    });
    // Ids only: a job's data and error text never go to the log.
    this.worker.on('failed', (job, err) =>
      withJobLogContext(job?.data, () => {
        this.logger.warn(`job ${job?.id ?? '?'} failed (${err.name})`);
        if (job) void this.reconcile(job, err);
      }),
    );
    this.worker.on('error', (err) => this.logger.error(`worker error (${err.name})`));
  }

  /**
   * A job that is finally failed (no retry left) must leave its document `failed`. Normally the
   * processor did that already; this covers a job BullMQ failed on its own (stalled too often) and
   * a database error while the processor recorded the last failure.
   */
  private async reconcile(job: Job, err: Error): Promise<void> {
    try {
      if ((await job.getState()) !== 'failed') return; // a retry is scheduled
      const code = /stalled/i.test(err.message) ? EXTRACTION_STALLED : EXTRACTION_RETRIES_EXHAUSTED;
      // BullMQ calls this listener outside the attempt's span: without its own span the final
      // write would be a trace of its own, cut off from the upload (T7.1).
      await this.traced(job, 'settle', () => this.processor.settleFailure(job.data, code));
    } catch {
      this.logger.warn(`could not reconcile job ${job.id ?? '?'}`);
    }
  }

  /** One attempt of a job (T7.1): see `traced`. */
  private handle(job: Job): Promise<void> {
    return this.traced(job, 'process', () => this.process(job));
  }

  /**
   * Runs `fn` in a CONSUMER span under the upload request that queued the job (the `traceparent` in
   * the job data). Ids only as attributes: the job data holds no content.
   */
  private traced<T>(job: Job, operation: 'process' | 'settle', fn: () => Promise<T>): Promise<T> {
    const data: unknown = job.data;
    const traceparent =
      typeof data === 'object' && data !== null && 'traceparent' in data
        ? data.traceparent
        : undefined;
    return withJobLogContext(data, () =>
      runInConsumerSpan(
        `${EXTRACTION_QUEUE} ${operation}`,
        traceparent,
        {
          'messaging.system': 'bullmq',
          'messaging.operation.type': operation,
          'messaging.destination.name': EXTRACTION_QUEUE,
          'messaging.message.id': job.id ?? '',
          'messaging.bullmq.attempt':
            operation === 'process' ? job.attemptsMade + 1 : job.attemptsMade,
        },
        fn,
      ),
    );
  }

  private async process(job: Job): Promise<void> {
    const guard = this.guard;
    if (guard === undefined) throw new Error(EXTRACTION_FAILED); // not bootstrapped
    try {
      // An open circuit or a rate limit gives the job back to the queue inside `run`.
      await guard.run(
        job,
        async (deferrals) =>
          (await this.processor.process(job.data, {
            attempt: job.attemptsMade + 1,
            maxAttempts: job.opts.attempts ?? MAX_ATTEMPTS,
            deferrals,
          })) === 'done',
        (e) => (e instanceof ExtractionJobError ? e.options : undefined),
      );
    } catch (e) {
      if (isRateLimitError(e)) throw e;
      // Unknown errors (e.g. the database is down) are retried like a handler failure would be.
      if (e instanceof ExtractionJobError && !e.retryable) throw new UnrecoverableError(e.code);
      if (e instanceof ExtractionJobError) throw e;
      throw new Error(EXTRACTION_FAILED);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.worker) return;
    // Graceful first: let running jobs finish. If Redis is unreachable that wait never ends, so
    // after the grace period the connection is cut and the worker closed forcibly (a job that was
    // running is then redelivered as stalled).
    await settleWithin(SHUTDOWN_GRACE_MS, this.worker.close());
    await settleWithin(SHUTDOWN_GRACE_MS, this.guard?.close() ?? Promise.resolve());
    this.connection?.disconnect();
    await settleWithin(SHUTDOWN_GRACE_MS, this.worker.close(true));
  }
}
