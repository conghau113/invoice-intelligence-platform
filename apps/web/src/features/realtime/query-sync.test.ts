import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST_REFRESH_WAIT_MS, querySync } from './query-sync';

const event = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  status: 'processing',
  version: 1,
});

describe('querySync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("marks the document's own query stale at once and the lists once per burst", () => {
    const invalidateQueries = vi.fn(() => Promise.resolve());
    const sync = querySync({ invalidateQueries });

    for (let n = 1; n <= 5; n += 1) sync.onEvent(event(n));
    const keys = () =>
      invalidateQueries.mock.calls.map(
        (c) => (c as unknown as [{ queryKey: unknown }])[0].queryKey,
      );
    expect(keys()).toEqual([1, 2, 3, 4, 5].map((n) => ['document', event(n).id]));

    vi.advanceTimersByTime(LIST_REFRESH_WAIT_MS);
    expect(keys().filter((k) => (k as string[])[0] === 'documents')).toEqual([['documents']]);
  });

  it('after a reconnect marks every document query stale', () => {
    const invalidateQueries = vi.fn(() => Promise.resolve());
    querySync({ invalidateQueries }).onResync();
    expect(
      invalidateQueries.mock.calls.map(
        (c) => (c as unknown as [{ queryKey: unknown }])[0].queryKey,
      ),
    ).toEqual([['document'], ['documents']]);
  });
});
