import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ProviderGuard, isRateLimitError } from './provider-guard';

/**
 * A connection that records the holds asked of Redis (the extend-only script itself runs against a
 * real Redis in test/resilience.int-spec.ts), and a queue that only has its limiter key.
 */
function fakes(failHold = false): { queue: Queue; connection: Redis; holds: number[] } {
  const holds: number[] = [];
  const connection = {
    defineCommand: () => undefined,
    extendHold: (_key: string, ms: number) => {
      if (failHold) return Promise.reject(new Error('down'));
      holds.push(ms);
      return Promise.resolve(1);
    },
  } as unknown as Redis;
  const queue = { keys: { limiter: 'bull:q:limiter' } } as unknown as Queue;
  return { queue, connection, holds };
}

const job = (id: string, attemptsStarted = 1, attemptsMade = 0) =>
  ({ id, attemptsStarted, attemptsMade }) as unknown as Job;

describe('ProviderGuard', () => {
  let now = 0;
  const logger = new Logger('test');
  beforeEach(() => {
    now = 0;
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  });
  const guardOn = ({ queue, connection }: { queue: Queue; connection: Redis }) =>
    new ProviderGuard(queue, connection, logger, { threshold: 2, cooldownMs: 1_000 }, () => now);

  it('a rate limit holds the queue for the wait and gives the job back (RateLimitError)', async () => {
    const f = fakes();
    const err = await guardOn(f)
      .failed({ deferMs: 7_000 }, 'a')
      .catch((e: unknown) => e);
    expect(isRateLimitError(err)).toBe(true);
    expect(f.holds).toEqual([7_000]);
  });

  it('past its deferrals a rate-limited job still holds the queue, but is not given back', async () => {
    const f = fakes();
    await expect(guardOn(f).failed({ holdMs: 7_000 }, 'a')).resolves.toBeUndefined();
    expect(f.holds).toEqual([7_000]);
  });

  it('rate limits do not count towards the breaker, nor reset its count', async () => {
    const f = fakes();
    const guard = guardOn(f);
    await guard.failed({ providerDown: true }, 'a');
    for (let i = 0; i < 5; i++) await guard.failed({ deferMs: 10 }, `r${i}`).catch(() => undefined);
    expect(guard.breakerState).toBe('closed');
    // The 429s in between did not wipe the first failure: one more opens it.
    await guard.failed({ providerDown: true }, 'b');
    expect(guard.breakerState).toBe('open');
  });

  it('provider failures of different jobs open the circuit and hold the queue for the cooldown', async () => {
    const f = fakes();
    const guard = guardOn(f);
    await guard.failed({ providerDown: true }, 'a');
    expect(f.holds).toEqual([]);
    await guard.failed({ providerDown: true }, 'b');
    expect(guard.breakerState).toBe('open');
    expect(f.holds).toEqual([1_000]);
  });

  it('while open, a job is given back untouched; after the cooldown one probe runs', async () => {
    const f = fakes();
    const guard = guardOn(f);
    await guard.failed({ providerDown: true }, 'a');
    await guard.failed({ providerDown: true }, 'b');
    now = 300;
    let ran = false;
    const work = () => {
      ran = true;
      return Promise.resolve(true);
    };
    const held = await guard.run(job('c'), work, () => undefined).catch((e: unknown) => e);
    expect(isRateLimitError(held)).toBe(true);
    expect(ran).toBe(false);
    expect(f.holds.at(-1)).toBe(700);
    now = 1_000;
    await guard.run(job('c'), work, () => undefined); // the probe
    expect(ran).toBe(true);
    expect(guard.breakerState).toBe('closed');
  });

  it('logs once when a probe closes the circuit, not for ordinary successes', async () => {
    const f = fakes();
    const guard = guardOn(f);
    const log = jest.spyOn(logger, 'log');
    log.mockClear();
    const ok = () => Promise.resolve(true);
    await guard.run(job('before'), ok, () => undefined);
    expect(log).not.toHaveBeenCalled();
    await guard.failed({ providerDown: true }, 'a');
    await guard.failed({ providerDown: true }, 'b');
    now = 1_000;
    await guard.run(job('probe'), ok, () => undefined);
    await guard.run(job('after'), ok, () => undefined);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('circuit closed'));
  });

  it('a job already running when the circuit opened closes it, and says so, when it succeeds', async () => {
    const f = fakes();
    const guard = guardOn(f);
    const log = jest.spyOn(logger, 'log');
    log.mockClear();
    // Concurrency 2: job "slow" is admitted while the circuit is still closed...
    let finish: (called: boolean) => void = () => undefined;
    const slow = guard.run(
      job('slow'),
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      () => undefined,
    );
    await Promise.resolve();
    // ...the other slot's failures open it meanwhile...
    await guard.failed({ providerDown: true }, 'a');
    await guard.failed({ providerDown: true }, 'b');
    expect(guard.breakerState).toBe('open');
    // ...then the slow job gets its answer: the service is up after all.
    finish(true);
    await slow;
    expect(guard.breakerState).toBe('closed');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('circuit closed'));
  });

  it('a probe that did not ask the provider anything does not close the circuit', async () => {
    const f = fakes();
    const guard = guardOn(f);
    await guard.failed({ providerDown: true }, 'a');
    await guard.failed({ providerDown: true }, 'b');
    now = 1_000;
    await guard.run(
      job('settled'),
      () => Promise.resolve(false),
      () => undefined,
    );
    expect(guard.breakerState).toBe('half-open');
    // The slot is free again for a real probe.
    await guard.run(
      job('real'),
      () => Promise.resolve(true),
      () => undefined,
    );
    expect(guard.breakerState).toBe('closed');
  });

  it('passes the deferrals of the job to the work and rethrows its error', async () => {
    const guard = guardOn(fakes());
    const seen: number[] = [];
    const boom = new Error('boom');
    await expect(
      guard.run(
        job('d', 6, 2),
        (deferrals) => {
          seen.push(deferrals);
          return Promise.reject(boom);
        },
        () => undefined,
      ),
    ).rejects.toBe(boom);
    expect(seen).toEqual([3]);
  });

  it('failures that say nothing about the provider do not open it', async () => {
    const f = fakes();
    const guard = guardOn(f);
    for (let i = 0; i < 5; i++) await guard.failed(undefined, `u${i}`);
    for (let i = 0; i < 5; i++) await guard.failed({}, `e${i}`);
    expect(guard.breakerState).toBe('closed');
    expect(f.holds).toEqual([]);
  });

  it('a hold Redis refused does not give the job back: its own retry happens instead', async () => {
    const guard = guardOn(fakes(true));
    await expect(guard.failed({ deferMs: 5_000 }, 'a')).resolves.toBeUndefined();
    await guard.failed({ providerDown: true }, 'a');
    await expect(guard.failed({ providerDown: true }, 'b')).resolves.toBeUndefined();
  });
});
