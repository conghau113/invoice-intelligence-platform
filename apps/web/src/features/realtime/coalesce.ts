/**
 * Runs `fn` once for a burst of calls: `waitMs` after the last call, and at least every `maxWaitMs`
 * while calls keep coming. Fifty uploads make ~150 events in a minute; the list is read again a
 * few times, not 150 times.
 */
export function coalesce(
  fn: () => void,
  waitMs: number,
  maxWaitMs: number,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (f, ms) => setTimeout(f, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): { call: () => void; cancel: () => void } {
  let trailing: unknown = null;
  let deadline: unknown = null;
  const fire = () => {
    cancel();
    fn();
  };
  const cancel = () => {
    if (trailing !== null) timers.clear(trailing);
    if (deadline !== null) timers.clear(deadline);
    trailing = null;
    deadline = null;
  };
  return {
    call: () => {
      if (trailing !== null) timers.clear(trailing);
      trailing = timers.set(fire, waitMs);
      deadline ??= timers.set(fire, maxWaitMs);
    },
    cancel,
  };
}
