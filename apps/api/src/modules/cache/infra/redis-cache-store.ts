import type { OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  CacheUnavailableError,
  type CacheOutcome,
  type CacheStore,
} from '../application/cache-store.port';
import { STATS_KEY, type CacheName } from '../domain/cache-keys';

// Compare-and-delete in one step: a GET then DEL could delete a lock another worker took in between.
const DELETE_IF_EQUALS = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

type WithDeleteIfEquals = Redis & { deleteIfEquals(key: string, value: string): Promise<unknown> };

/**
 * The cache in Redis (ADR 0013). Use a connection that fails at once while Redis is down
 * (`producerConnection`): a read must fall back to Postgres, not wait for Redis to come back.
 */
export class RedisCacheStore implements CacheStore, OnApplicationShutdown {
  private readonly redis: WithDeleteIfEquals;

  constructor(redis: Redis) {
    redis.defineCommand('deleteIfEquals', { numberOfKeys: 1, lua: DELETE_IF_EQUALS });
    this.redis = redis as WithDeleteIfEquals;
  }

  get(key: string): Promise<string | null> {
    return this.guard(this.redis.get(key));
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.guard(this.redis.set(key, value, 'PX', ttlMs));
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    return (await this.guard(this.redis.set(key, value, 'PX', ttlMs, 'NX'))) === 'OK';
  }

  async deleteIfEquals(key: string, value: string): Promise<void> {
    await this.guard(this.redis.deleteIfEquals(key, value));
  }

  async readCounter(key: string): Promise<number> {
    const raw = await this.guard(this.redis.get(key));
    const n = raw === null ? 0 : Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) throw new CacheUnavailableError();
    return n;
  }

  increment(key: string): Promise<number> {
    return this.guard(this.redis.incr(key));
  }

  count(name: CacheName, outcome: CacheOutcome): void {
    this.redis.hincrby(STATS_KEY, `${name}:${outcome}`, 1).catch(() => undefined);
  }

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }

  private async guard<T>(command: Promise<T>): Promise<T> {
    try {
      return await command;
    } catch {
      // The ioredis message names the host; the caller only needs to know there is no answer.
      throw new CacheUnavailableError();
    }
  }
}
