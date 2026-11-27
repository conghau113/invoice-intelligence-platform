import { AsyncLocalStorage } from 'node:async_hooks';

/** Ids that every log line written inside `runWithLogContext` carries. Ids only, never content. */
export interface LogContext {
  tenantId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with `context` merged into the current one (an inner tenant wins). */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}
