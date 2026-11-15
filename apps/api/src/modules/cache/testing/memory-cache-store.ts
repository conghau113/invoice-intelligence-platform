import {
  CacheUnavailableError,
  type CacheOutcome,
  type CacheStore,
} from '../application/cache-store.port';
import type { CacheName } from '../domain/cache-keys';

/** CacheStore in a Map, for unit tests. `down = true` makes every command fail like a dead Redis. */
export class MemoryCacheStore implements CacheStore {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  readonly counts = new Map<string, number>();
  down = false;

  get(key: string): Promise<string | null> {
    return this.answer(() => this.values.get(key) ?? null);
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    return this.answer(() => {
      this.values.set(key, value);
      this.ttls.set(key, ttlMs);
    });
  }

  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    return this.answer(() => {
      if (this.values.has(key)) return false;
      this.values.set(key, value);
      this.ttls.set(key, ttlMs);
      return true;
    });
  }

  deleteIfEquals(key: string, value: string): Promise<void> {
    return this.answer(() => {
      if (this.values.get(key) === value) this.values.delete(key);
    });
  }

  readCounter(key: string): Promise<number> {
    return this.answer(() => Number(this.values.get(key) ?? 0));
  }

  increment(key: string): Promise<number> {
    return this.answer(() => {
      const n = Number(this.values.get(key) ?? 0) + 1;
      this.values.set(key, String(n));
      return n;
    });
  }

  count(name: CacheName, outcome: CacheOutcome): void {
    const field = `${name}:${outcome}`;
    this.counts.set(field, (this.counts.get(field) ?? 0) + 1);
  }

  private answer<T>(fn: () => T): Promise<T> {
    if (this.down) return Promise.reject(new CacheUnavailableError());
    return Promise.resolve(fn());
  }
}
