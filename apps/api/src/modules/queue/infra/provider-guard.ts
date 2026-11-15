import type { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../../../config/env.schema';
import {
  CircuitBreaker,
  MAX_BREAKER_COOLDOWN_MS,
  deferralsOf,
  jobSpacingMs,
  type BreakerSettings,
} from '../../extraction/resilience';

/** What a processor's error says about the provider (ExtractionJobError, IndexJobError). */
export interface ProviderSignal {
  /** Over the provider's rate limit: hold the queue this long and give the job back, attempt kept. */
  deferMs?: number;
  /** Over its rate limit, but the job has waited enough: hold the queue; the attempt is used. */
  holdMs?: number;
  /** The AI service or the provider could not answer. */
  providerDown?: boolean;
}

/** Which plan limits pace a queue: the generate model (extraction) or the embedding model. */
export interface QueuePlan {
  rpm: 'LLM_RPM' | 'EMBED_RPM';
  tpm: 'LLM_TPM' | 'EMBED_TPM';
  tokensPerJob: number;
}

/**
 * Sets the queue's limiter key to "full" for `ARGV[1]` ms, but only when that is LONGER than the
 * hold already there: two jobs meeting a 429 at once (120 s, then 2 s), or a 429 during an open
 * circuit, must not shorten the wait. Same value as BullMQ's own `queue.rateLimit`
 * (MAX_SAFE_INTEGER), so its fetch loop reads it the same way. One script: no read-then-write race.
 */
const EXTEND_HOLD_LUA = `
local ttl = redis.call('PTTL', KEYS[1])
if ttl < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[1])
  return 1
end
return 0
`;

/** BullMQ's "give this job back" error (it compares the message, see Worker.handleFailed). */
export const isRateLimitError = (e: unknown): boolean =>
  e instanceof Error && e.message === Worker.RateLimitError().message;

type WithExtendHold = Redis & {
  extendHold(key: string, ms: number, value: string): Promise<number>;
};

/**
 * The BullMQ side of resilience.ts for one queue in one worker process: the pace of job starts,
 * the circuit breaker, and holding the whole queue when the provider says wait (T6.2).
 *
 * Holding sets the queue's limiter key in Redis, so every worker process stops fetching until it
 * expires. Throwing BullMQ's RateLimitError then moves the current job from active back to waiting
 * without counting a failed attempt (moveJobFromActiveToWait, BullMQ 6); only `attemptsStarted`
 * grows, which is how the deferrals of a job are counted (`deferralsOf`).
 */
export class ProviderGuard {
  private readonly breaker: CircuitBreaker;
  private readonly redis: WithExtendHold;

  constructor(
    private readonly queue: Queue,
    connection: Redis,
    private readonly logger: Logger,
    settings: Omit<BreakerSettings, 'maxCooldownMs'>,
    now: () => number = Date.now,
  ) {
    this.breaker = new CircuitBreaker({ ...settings, maxCooldownMs: MAX_BREAKER_COOLDOWN_MS }, now);
    connection.defineCommand('extendHold', { numberOfKeys: 1, lua: EXTEND_HOLD_LUA });
    this.redis = connection as WithExtendHold;
  }

  /**
   * The guard of queue `name` as a worker wires it: its own Queue on the worker's connection, the
   * breaker settings, and the BullMQ limiter that spaces job starts to the plan (resilience.ts).
   */
  static forQueue(
    name: string,
    connection: Redis,
    config: ConfigService<Env, true>,
    plan: QueuePlan,
    logger: Logger,
  ): { guard: ProviderGuard; limiter: { max: number; duration: number } } {
    const queue = new Queue(name, { connection });
    queue.on('error', () => logger.error(`${name} queue error`));
    const guard = new ProviderGuard(queue, connection, logger, {
      threshold: config.get('BREAKER_THRESHOLD', { infer: true }),
      cooldownMs: config.get('BREAKER_COOLDOWN_MS', { infer: true }),
    });
    const duration = jobSpacingMs({
      rpm: config.get(plan.rpm, { infer: true }),
      tpm: config.get(plan.tpm, { infer: true }),
      tokensPerJob: plan.tokensPerJob,
      minuteMs: config.get('PROVIDER_MINUTE_MS', { infer: true }),
    });
    return { guard, limiter: { max: 1, duration } };
  }

  get breakerState(): CircuitBreaker['state'] {
    return this.breaker.state;
  }

  /**
   * Runs one job under the guard. `work` gets the job's deferrals so far and resolves `true` when
   * it asked the AI service something (only that may close the circuit), `false` when it did not
   * (an already settled document). On an error, `signalOf` reads what it says about the provider;
   * the error is then rethrown for the worker to map, unless a rate limit gave the job back.
   */
  async run(
    job: Job,
    work: (deferrals: number) => Promise<boolean>,
    signalOf: (e: unknown) => ProviderSignal | undefined,
  ): Promise<void> {
    await this.admit();
    let called: boolean;
    try {
      called = await work(deferralsOf(job));
    } catch (e) {
      await this.failed(signalOf(e), String(job.id));
      throw e;
    }
    if (called) this.breaker.onSuccess();
    else this.breaker.release();
  }

  /** Before a job: when the circuit is open the job goes back to the queue, untouched. */
  async admit(): Promise<void> {
    const waitMs = this.breaker.admit();
    if (waitMs !== undefined && (await this.hold(waitMs))) throw Worker.RateLimitError();
  }

  /**
   * After a failed job `jobKey`. A rate limit holds the queue (and, if the job may still wait, gives
   * it back: this then throws RateLimitError). A provider failure counts towards the breaker; when
   * it opens, the queue is held for the cooldown. Anything else says nothing about the provider.
   */
  async failed(signal: ProviderSignal | undefined, jobKey: string): Promise<void> {
    const holdMs = signal?.deferMs ?? signal?.holdMs;
    if (holdMs !== undefined) {
      // Busy, not broken: no verdict for the breaker (an interleaving of 429s and 5xx must not
      // keep resetting its count), but a probe must free its slot.
      this.breaker.release();
      this.logger.warn(`provider rate limit: holding the queue ${holdMs} ms`);
      const held = await this.hold(holdMs);
      // Give the job back only once the hold is in place; if Redis refused it, the job's own
      // retry (an attempt) happens instead.
      if (signal?.deferMs !== undefined && held) throw Worker.RateLimitError();
      return;
    }
    if (signal?.providerDown !== true) {
      this.breaker.release();
      return;
    }
    const pauseMs = this.breaker.onFailure(jobKey);
    if (pauseMs === undefined) return;
    this.logger.warn(`circuit open: AI service or provider failing, queue held ${pauseMs} ms`);
    await this.hold(pauseMs);
  }

  /** Holds the whole queue for at least `ms` (never shortens a longer hold); false if Redis failed. */
  async hold(ms: number): Promise<boolean> {
    const key = this.queue.keys.limiter;
    if (key === undefined) return false; // BullMQ always names it; kept so the type narrows
    try {
      await this.redis.extendHold(key, ms, String(Number.MAX_SAFE_INTEGER));
      return true;
    } catch {
      this.logger.warn('could not hold the queue (Redis)');
      return false;
    }
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
