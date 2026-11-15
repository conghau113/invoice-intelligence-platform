import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { z } from 'zod';
import { GENERATION, generationKey, readKey, type ReadCacheName } from '../domain/cache-keys';
import { CACHE_ENABLED, CACHE_STORE, type CacheStore } from './cache-store.port';

/** What a write path needs: "this tenant's data changed". */
export interface TenantCacheInvalidator {
  /** Call after COMMIT (TenantDbService.afterCommit). Never throws. */
  invalidate(tenantId: string): Promise<void>;
}
export const TENANT_CACHE_INVALIDATOR = Symbol('TENANT_CACHE_INVALIDATOR');

/** For code built by hand without a cache (unit and integration tests that test something else). */
export const NO_CACHE_INVALIDATION: TenantCacheInvalidator = {
  invalidate: () => Promise.resolve(),
};

export interface ReadSpec<T> {
  tenantId: string;
  name: ReadCacheName;
  /** The validated query; becomes part of the key. */
  params?: Readonly<Record<string, string | number | undefined>>;
  /** Parses what comes back from Redis. A value that does not parse is a miss, never an error. */
  schema: z.ZodType<T>;
  ttlMs: number;
}

/** Up to 10% shorter, so keys filled together do not all expire in the same instant. */
export function withJitter(ttlMs: number): number {
  return ttlMs - randomInt(0, Math.floor(ttlMs / 10) + 1);
}

/**
 * Cache-aside for expensive per-tenant reads (ADR 0013): look in Redis, else load from Postgres and
 * keep the answer for a short TTL. Freshness comes from the tenant's generation counter, bumped after
 * every committed write (`invalidate`), so a cached answer is at most one write behind only while a
 * bump failed, and then for its TTL at most.
 *
 * Order matters: the generation is read BEFORE the database. A reader that loaded old rows while a
 * writer committed therefore stores them under the old generation, which nobody reads after the bump.
 * Redis down: every read goes to Postgres (fail open), as the rate limiter's reads do.
 */
@Injectable()
export class TenantReadCache implements TenantCacheInvalidator {
  private readonly logger = new Logger(TenantReadCache.name);
  // Request coalescing: concurrent misses on one key share one database query (cache stampede).
  // Per process only; one API instance today.
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(CACHE_STORE) private readonly store: CacheStore,
    @Inject(CACHE_ENABLED) private readonly enabled: boolean,
  ) {}

  async read<T>(spec: ReadSpec<T>, load: () => Promise<T>): Promise<T> {
    if (!this.enabled) return load();
    let key: string;
    try {
      const generation = await this.store.readCounter(generationKey(spec.tenantId));
      key = readKey(spec.tenantId, generation, spec.name, spec.params);
      const cached = await this.store.get(key);
      const value = cached === null ? undefined : parse(cached, spec.schema);
      if (value !== undefined) {
        this.store.count(spec.name, 'hit');
        return value;
      }
    } catch {
      this.store.count(spec.name, 'error');
      return load();
    }

    // Waiters get the very object the first caller got (and its error, if it fails): callers must
    // treat a read as immutable, which every current one does (they return it as the response).
    const running = this.inFlight.get(key) as Promise<T> | undefined;
    if (running !== undefined) {
      this.store.count(spec.name, 'coalesced');
      return running;
    }
    this.store.count(spec.name, 'miss');
    const work = (async () => {
      const value = await load();
      // A failed write only costs the next reader a query.
      await this.store
        .set(key, JSON.stringify(value), withJitter(spec.ttlMs))
        .catch(() => undefined);
      return value;
    })();
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async invalidate(tenantId: string): Promise<void> {
    // Bumped even with the cache off, so turning it back on cannot serve an entry from before.
    try {
      await this.store.increment(generationKey(tenantId));
    } catch {
      this.store.count(GENERATION, 'error');
      // Ids and codes only. The cached reads stay one write behind until their TTL ends.
      this.logger.warn('Cache invalidation failed (CACHE_UNAVAILABLE)');
    }
  }
}

function parse<T>(raw: string, schema: z.ZodType<T>): T | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
