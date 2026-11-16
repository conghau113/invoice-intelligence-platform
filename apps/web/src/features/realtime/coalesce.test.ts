import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coalesce } from './coalesce';

describe('coalesce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once for a burst, after the last call', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 300, 1_000);
    c.call();
    vi.advanceTimersByTime(200);
    c.call();
    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still runs at least every maxWait while calls keep coming', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 300, 1_000);
    for (let t = 0; t < 2_500; t += 100) {
      c.call();
      vi.advanceTimersByTime(100);
    }
    expect(fn).toHaveBeenCalledTimes(2); // at 1 000 and 2 000 ms
  });

  it('runs nothing after cancel', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 300, 1_000);
    c.call();
    c.cancel();
    vi.advanceTimersByTime(5_000);
    expect(fn).not.toHaveBeenCalled();
  });
});
