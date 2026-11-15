import type { CacheName } from '../domain/cache-keys';

export const CACHE_STORE = Symbol('CACHE_STORE');
/** CACHE_ENABLED: false turns every cache off (reads go to Postgres, extraction always calls the AI). */
export const CACHE_ENABLED = Symbol('CACHE_ENABLED');

/** `skipped`: an answer not stored because it came from another model or prompt than the key. */
export type CacheOutcome = 'hit' | 'miss' | 'coalesced' | 'error' | 'skipped';

/** Redis gave no usable answer. Callers treat it as a miss: the cache is never the source of truth. */
export class CacheUnavailableError extends Error {
  constructor() {
    super('Cache unavailable');
    this.name = 'CacheUnavailableError';
  }
}

/**
 * The few commands the caches need. Every method rejects with CacheUnavailableError only, never
 * with the client's own error (its message names the host).
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** SET NX PX: true when this caller got the key. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Deletes the key only while it still holds `value` (a lock released by its owner only). */
  deleteIfEquals(key: string, value: string): Promise<void>;
  /** The current number, 0 when the key does not exist. */
  readCounter(key: string): Promise<number>;
  increment(key: string): Promise<number>;
  /** Fire and forget: counting must never slow a request or fail it. */
  count(name: CacheName, outcome: CacheOutcome): void;
}
