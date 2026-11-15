import {
  CircuitBreaker,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  MAX_ERROR_BODY_BYTES,
  MAX_RATE_LIMIT_DEFERRALS,
  MAX_RATE_LIMIT_WAIT_MS,
  deferralsOf,
  jobSpacingMs,
  jobsPerMinute,
  mayDefer,
  parseRetryAfterMs,
  rateLimitHoldMs,
  readErrorCode,
  type ProviderLimits,
} from './resilience';

const MINUTE = 60_000;
const limits = (over: Partial<ProviderLimits> = {}): ProviderLimits => ({
  rpm: 15,
  tpm: 1_000_000,
  tokensPerJob: 16_000,
  minuteMs: MINUTE,
  ...over,
});

/** Most starts found in any closed window of `windowMs` (the starts are sorted). */
function busiestWindow(starts: number[], windowMs: number): number {
  let best = 0;
  let from = 0;
  for (let to = 0; to < starts.length; to++) {
    while ((starts[to] ?? 0) - (starts[from] ?? 0) > windowMs) from += 1;
    best = Math.max(best, to - from + 1);
  }
  return best;
}

describe('pacing the queue to the provider plan', () => {
  it('takes the tighter of RPM and TPM, and never less than one job a minute', () => {
    expect(jobsPerMinute(limits({ rpm: 15, tpm: 1_000_000 }))).toBe(15);
    expect(jobsPerMinute(limits({ rpm: 15, tpm: 100_000 }))).toBe(6); // 100k / 16k
    expect(jobsPerMinute(limits({ rpm: 15, tpm: 1_000 }))).toBe(1);
  });

  it.each([1, 2, 3, 7, 10, 15, 60, 1000])(
    'at %i per minute, starts spaced by the gap never put more than that in any minute',
    (rpm) => {
      // TPM out of the way, so RPM is the limit being tested.
      const gap = jobSpacingMs(limits({ rpm, tpm: 1e12 }));
      // Jobs started as early as the limiter allows, i.e. exactly one gap apart.
      const starts = Array.from({ length: rpm * 5 + 3 }, (_, i) => i * gap);
      expect(busiestWindow(starts, MINUTE)).toBeLessThanOrEqual(rpm);
      // And not much slower than the plan (the gap is rounded up to whole ms).
      expect(Math.floor(MINUTE / gap) + 1).toBeGreaterThanOrEqual(Math.floor(rpm * 0.95));
    },
  );

  it('scales with the length of the minute (tests run it in a second)', () => {
    expect(jobSpacingMs(limits({ rpm: 5, minuteMs: 1_000 }))).toBe(250);
  });
});

describe('Retry-After', () => {
  it('reads whole seconds, at least 1 s and at most the cap', () => {
    expect(parseRetryAfterMs('7')).toBe(7_000);
    expect(parseRetryAfterMs(' 12 ')).toBe(12_000);
    expect(parseRetryAfterMs('0')).toBe(1_000);
    expect(parseRetryAfterMs('999999')).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });

  it.each([null, undefined, '', 'soon', '-1', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT', '1234567'])(
    'ignores %j',
    (header) => {
      expect(parseRetryAfterMs(header)).toBeUndefined();
    },
  );

  it('holds the queue what the provider asked, or a default, capped', () => {
    expect(rateLimitHoldMs(9_000)).toBe(9_000);
    expect(rateLimitHoldMs(undefined)).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
    expect(rateLimitHoldMs(MAX_RATE_LIMIT_WAIT_MS * 10)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });

  it('gives a job back until it has been given back enough times (a daily quota is gone)', () => {
    expect(mayDefer(0)).toBe(true);
    expect(mayDefer(MAX_RATE_LIMIT_DEFERRALS - 1)).toBe(true);
    expect(mayDefer(MAX_RATE_LIMIT_DEFERRALS)).toBe(false);
  });

  it('counts the deferrals from BullMQ counters, not from the age of the job', () => {
    // First start of a fresh job, or of one an admin retried (BullMQ resets both counters).
    expect(deferralsOf({ attemptsStarted: 1, attemptsMade: 0 })).toBe(0);
    // Two attempts failed and three starts went back to the queue, now the sixth start.
    expect(deferralsOf({ attemptsStarted: 6, attemptsMade: 2 })).toBe(3);
    expect(deferralsOf({ attemptsStarted: 0, attemptsMade: 0 })).toBe(0);
  });
});

describe('readErrorCode', () => {
  it('returns the code of a short JSON body', async () => {
    const res = Response.json({ code: 'LLM_RATE_LIMITED', message: 'x' }, { status: 503 });
    expect(await readErrorCode(res)).toBe('LLM_RATE_LIMITED');
  });

  it('gives up on a body larger than the limit, without reading it all', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024).fill(0x20);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    expect(await readErrorCode(new Response(endless, { status: 503 }))).toBeUndefined();
    expect(pulled).toBeLessThanOrEqual(MAX_ERROR_BODY_BYTES / chunk.byteLength + 2);
  });

  it.each([
    ['not JSON', new Response('<html>oops</html>', { status: 502 })],
    ['no body', new Response(null, { status: 502 })],
    ['JSON null', new Response('null', { status: 502 })],
  ])('is undefined for %s', async (_label, res) => {
    expect(await readErrorCode(res)).toBeUndefined();
  });
});

describe('CircuitBreaker', () => {
  const settings = { threshold: 3, cooldownMs: 1_000, maxCooldownMs: 4_000 };
  let now = 0;
  const breaker = () => new CircuitBreaker(settings, () => now);
  /** A different job each time (the failures that open it must come from different jobs). */
  let n = 0;
  const next = () => `job-${(n += 1)}`;
  beforeEach(() => {
    now = 0;
  });

  it('stays closed below the threshold, and a success resets the count', () => {
    const b = breaker();
    expect(b.onFailure(next())).toBeUndefined();
    expect(b.onFailure(next())).toBeUndefined();
    b.onSuccess();
    expect(b.onFailure(next())).toBeUndefined();
    expect(b.onFailure(next())).toBeUndefined();
    expect(b.state).toBe('closed');
    expect(b.admit()).toBeUndefined();
  });

  it('opens on the Nth failure in a row and holds jobs for the cooldown', () => {
    const b = breaker();
    b.onFailure(next());
    b.onFailure(next());
    expect(b.onFailure(next())).toBe(1_000);
    expect(b.state).toBe('open');
    now = 400;
    expect(b.admit()).toBe(600);
  });

  it('after the cooldown lets exactly one probe through; its success closes the circuit', () => {
    const b = breaker();
    for (let i = 0; i < 3; i++) b.onFailure(next());
    now = 1_000;
    expect(b.admit()).toBeUndefined(); // the probe
    expect(b.state).toBe('half-open');
    expect(b.admit()).toBeGreaterThan(0); // a second job waits for the probe
    b.onSuccess();
    expect(b.state).toBe('closed');
    expect(b.admit()).toBeUndefined();
  });

  it('a failed probe opens it again for twice as long, up to the maximum', () => {
    const b = breaker();
    for (let i = 0; i < 3; i++) b.onFailure(next());
    const pauses: number[] = [];
    for (let round = 0; round < 4; round++) {
      now += 10_000;
      expect(b.admit()).toBeUndefined();
      pauses.push(b.onFailure(next()) ?? -1);
    }
    expect(pauses).toEqual([2_000, 4_000, 4_000, 4_000]);
    // A success closes it and the next opening starts from the first cooldown again.
    now += 10_000;
    b.admit();
    b.onSuccess();
    for (let i = 0; i < 2; i++) b.onFailure(next());
    expect(b.onFailure(next())).toBe(1_000);
  });

  it('a probe that says nothing about the provider frees the slot for the next one', () => {
    const b = breaker();
    for (let i = 0; i < 3; i++) b.onFailure(next());
    now = 1_000;
    expect(b.admit()).toBeUndefined();
    b.release();
    expect(b.admit()).toBeUndefined();
    expect(b.state).toBe('half-open');
  });

  it('one job failing again and again does not open it: it is that job, not the provider', () => {
    const b = breaker();
    for (let i = 0; i < 10; i++) expect(b.onFailure('poison')).toBeUndefined();
    expect(b.state).toBe('closed');
    expect(b.onFailure('other-1')).toBeUndefined();
    expect(b.onFailure('other-2')).toBe(1_000); // three different jobs
  });
});
