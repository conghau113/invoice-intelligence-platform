import { Redis } from 'ioredis';

/** A request must not wait on a dead Redis: this is the longest one command may take. */
export const COMMAND_TIMEOUT_MS = 2_000;

/**
 * Connection for code that serves HTTP. With the default offline queue a command sent while Redis
 * is down is parked until it comes back, which hangs the request. Here it fails at once and the
 * API answers 503. ioredis keeps reconnecting in the background.
 */
export function producerConnection(url: string): Redis {
  return swallowErrorEvents(
    new Redis(url, {
      enableOfflineQueue: false,
      commandTimeout: COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
    }),
  );
}

/**
 * Connection for the worker. BullMQ requires `maxRetriesPerRequest: null` here: its blocking
 * commands wait for jobs for a long time and must not be cut off.
 */
export function workerConnection(url: string): Redis {
  return swallowErrorEvents(new Redis(url, { maxRetriesPerRequest: null }));
}

/**
 * An 'error' event with no listener would crash the process. The error is dropped on purpose:
 * ioredis messages contain the host name, and callers see the failure through their own commands.
 */
function swallowErrorEvents(redis: Redis): Redis {
  redis.on('error', () => undefined);
  return redis;
}

/**
 * Resolves when `work` settles or after `ms`, whichever is first; never rejects. For shutdown, where
 * a Redis that is gone makes BullMQ's close() wait forever and the process must still exit.
 */
export async function settleWithin(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
