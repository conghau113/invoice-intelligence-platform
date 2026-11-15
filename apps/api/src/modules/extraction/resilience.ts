/**
 * How the queues behave towards an LLM provider that is busy or down (T6.2, AI_PIPELINE.md §8).
 * Plain functions and one small state machine, with the clock passed in, so every rule here is
 * tested without BullMQ or Redis; the workers only wire them up.
 *
 * Three layers, from the gentlest:
 *  1. Pace: the queue starts jobs no faster than the provider allows (RPM/TPM), so 429 is rare.
 *  2. Wait when told: a 429 (or a wait the provider names) holds the WHOLE queue for that long and
 *     puts the job back without using one of its attempts. The provider is fine, only busy.
 *  3. Circuit breaker: several failures in a row (the service or the provider is down) stop the
 *     queue for a while, then let one job through to test the water before opening the tap again.
 */

/** Code the AI service gives a provider's 429 (apps/ai `LLM_RATE_LIMITED`). */
export const RATE_LIMITED_CODE = 'LLM_RATE_LIMITED';

/**
 * Longest single wait the queue honours; a longer Retry-After (a daily quota) is cut to this. The
 * AI service caps what it passes on at the same 300 s (`MAX_RETRY_AFTER_S`, apps/ai providers/base.py).
 */
export const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;

/** A 429 without a named wait: hold the queue this long (provider quotas are per minute). */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 30_000;

/**
 * After this many times back in the queue, a 429 counts as a normal failed attempt: with a daily
 * quota used up, jobs must end with a clear code (LLM_RATE_LIMITED) instead of waiting forever.
 * About 30 min at the default 30 s wait. Counted per job from BullMQ's `attemptsStarted -
 * attemptsMade` (the starts that were not attempts), which an admin retry resets, so a document
 * retried days later gets its waits again. Not its age: that keeps the first upload time.
 */
export const MAX_RATE_LIMIT_DEFERRALS = 60;

/**
 * Upper estimate of the tokens one extraction uses: the prompt and up to 5 page images (~4,000)
 * plus the output cap (`MAX_OUTPUT_TOKENS` 12,288 in apps/ai). Most invoices use far less, so with
 * a TPM limit this errs on the safe side.
 */
export const EXTRACTION_TOKENS_PER_JOB = 16_000;

/**
 * Estimate for one index job: an average invoice is a few chunks of under 2,000 characters
 * (~500 tokens each). A 500-line invoice is far bigger (51 chunks) and may still meet a 429,
 * which then holds the queue (TASKS.md Phát sinh T5.3: batching by tokens is on the AI side).
 */
export const INDEX_TOKENS_PER_JOB = 4_000;

/** Longest pause of an open circuit, however many probes failed. */
export const MAX_BREAKER_COOLDOWN_MS = 10 * 60_000;

/** What one provider allows and what one job of a queue costs, all settable (AI_PIPELINE.md §8). */
export interface ProviderLimits {
  /** Requests per minute the plan allows. */
  rpm: number;
  /** Tokens per minute the plan allows. */
  tpm: number;
  /** Upper estimate of the tokens one job uses (input and output). */
  tokensPerJob: number;
  /** Length of the provider's "minute" in ms: 60 000, smaller only in tests. */
  minuteMs: number;
}

/** Jobs per minute the provider allows: the tighter of its request and token limits, at least 1. */
export function jobsPerMinute({ rpm, tpm, tokensPerJob }: ProviderLimits): number {
  return Math.max(1, Math.min(rpm, Math.floor(tpm / tokensPerJob)));
}

/**
 * Minimum gap between two job starts, for BullMQ's limiter `{ max: 1, duration: gap }`.
 *
 * BullMQ counts jobs in a window that opens with the first job and lasts `duration`. With
 * `max: N` all N jobs may start at the end of one window and N more at the start of the next, so a
 * sliding minute could see up to 2N. With `max: 1` every start is at least `gap` after the last, so
 * any closed minute holds at most floor(minute / gap) + 1 starts. `gap = minute / (n - 1)` makes
 * that exactly n (and n = 1 needs a gap longer than the minute). The cost: no bursts, which is
 * what a per-minute quota wants anyway.
 */
export function jobSpacingMs(limits: ProviderLimits): number {
  const n = jobsPerMinute(limits);
  return n === 1 ? limits.minuteMs + 1 : Math.ceil(limits.minuteMs / (n - 1));
}

/**
 * `Retry-After` in seconds (the only form the AI service sends) to milliseconds, at least 1 s and
 * at most MAX_RATE_LIMIT_WAIT_MS. Anything else (absent, a date, garbage) is undefined.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined || !/^\d{1,6}$/.test(header.trim())) return undefined;
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(1, Number(header.trim())) * 1000);
}

/** How long to hold the queue after a 429: the provider's wait, or the default, capped. */
export function rateLimitHoldMs(retryAfterMs: number | undefined): number {
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS);
}

/** Whether a rate-limited job goes back to the queue (true) or uses one of its attempts (false). */
export const mayDefer = (deferrals: number): boolean => deferrals < MAX_RATE_LIMIT_DEFERRALS;

/** Times a job went back to the queue without an attempt (BullMQ counters, this start excluded). */
export const deferralsOf = (job: { attemptsStarted: number; attemptsMade: number }): number =>
  Math.max(0, job.attemptsStarted - job.attemptsMade - 1);

/** Bytes of an error body read at most: enough for `{code, message}`, never a whole document. */
export const MAX_ERROR_BODY_BYTES = 4096;

/**
 * The `code` of an AI service error body, reading at most MAX_ERROR_BODY_BYTES. The caller still
 * checks the value against its own list. Never throws; the rest of the body is discarded unread.
 */
export async function readErrorCode(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (reader === undefined) return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ERROR_BODY_BYTES) break; // not kept: one large chunk must not stay in memory
      parts.push(value);
    }
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (size > MAX_ERROR_BODY_BYTES) return undefined; // too long to be ours
  try {
    const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { code?: unknown } | null;
    return body?.code;
  } catch {
    return undefined;
  }
}

export interface BreakerSettings {
  /** Failures in a row, from that many DIFFERENT jobs, that open the circuit. */
  threshold: number;
  /** First pause when it opens; doubled each time a probe fails, up to maxCooldownMs. */
  cooldownMs: number;
  maxCooldownMs: number;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker for one worker process. `closed`: jobs run. After `threshold` provider failures in
 * a row it is `open`: no job starts until the cooldown is over. Then `half-open`: exactly one job
 * (the probe) runs; its success closes the circuit, its failure opens it again for twice as long.
 *
 * The failures must come from `threshold` different jobs. The queue is shared by every tenant: one
 * document that makes the AI service time out on each of its retries is that document's problem,
 * and must not stop everybody else's documents (it fails on its own after its attempts).
 *
 * The worker also holds the shared queue for the cooldown (BullMQ rate limit in Redis), so other
 * worker processes stop fetching too and the jobs simply wait: none is failed by the breaker.
 */
export class CircuitBreaker {
  /** Jobs that failed since the last success, in this run of failures. */
  private readonly failing = new Set<string>();
  private openUntil = 0;
  private cooldownMs: number;
  private probing = false;
  private current: BreakerState = 'closed';

  constructor(
    private readonly settings: BreakerSettings,
    private readonly now: () => number = Date.now,
  ) {
    this.cooldownMs = settings.cooldownMs;
  }

  get state(): BreakerState {
    return this.current;
  }

  /**
   * Before a job runs: undefined to go on, or how long to wait (the job goes back to the queue).
   * Once the cooldown is over the first caller becomes the probe; others keep waiting until it ends.
   */
  admit(): number | undefined {
    if (this.current === 'closed') return undefined;
    const left = this.openUntil - this.now();
    if (this.current === 'open' && left > 0) return left;
    if (this.probing) return Math.max(1_000, Math.min(this.cooldownMs, 5_000));
    this.current = 'half-open';
    this.probing = true;
    return undefined;
  }

  /** The provider answered (a valid result, or a verdict on the file): the dependency is up. */
  onSuccess(): void {
    this.failing.clear();
    this.probing = false;
    this.current = 'closed';
    this.cooldownMs = this.settings.cooldownMs;
  }

  /**
   * The service or the provider could not answer job `jobKey`. Returns the pause to apply to the
   * whole queue when this failure opens the circuit, else undefined.
   */
  onFailure(jobKey: string): number | undefined {
    if (this.current === 'half-open') {
      // The probe failed: stay away longer this time.
      this.cooldownMs = Math.min(this.settings.maxCooldownMs, this.cooldownMs * 2);
      return this.open();
    }
    this.failing.add(jobKey);
    if (this.current === 'closed' && this.failing.size >= this.settings.threshold) {
      return this.open();
    }
    return undefined;
  }

  /**
   * The job ended without telling anything about the provider (the database failed, the job was
   * malformed): no verdict, but a probe must not hold the half-open slot forever.
   */
  release(): void {
    this.probing = false;
  }

  private open(): number {
    this.current = 'open';
    this.probing = false;
    this.failing.clear();
    this.openUntil = this.now() + this.cooldownMs;
    return this.cooldownMs;
  }
}
