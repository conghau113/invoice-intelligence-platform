import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { DEFAULT_LLM_TIMEOUT_MS } from '../extraction/infra/http-ai-extractor';
import { producerConnection } from '../queue/infra/redis-connection';
import { CACHE_ENABLED, CACHE_STORE } from './application/cache-store.port';
import {
  DEFAULT_POLL_MS,
  DEFAULT_RESULT_TTL_MS,
  EXTRACTION_CACHE_OPTIONS,
  ExtractionResultCache,
  type ExtractionCacheOptions,
} from './application/extraction-result-cache';
import { TENANT_CACHE_INVALIDATOR, TenantReadCache } from './application/tenant-read-cache';
import { RedisCacheStore } from './infra/redis-cache-store';

/**
 * A cache command is a key lookup: a Redis that hangs must cost a read little, since the read can
 * always go to Postgres. A miss path makes two lookups and a write bump one, so ~1 s at worst.
 */
export const CACHE_COMMAND_TIMEOUT_MS = 500;

/** A lock outlives the AI call it guards by this much, so a slow answer is still shared. */
const LOCK_MARGIN_MS = 5_000;

/**
 * Caches of ADR 0013: cache-aside for list/dashboard reads and the extraction result cache. Used by
 * the API and the worker process (the worker's status changes invalidate the reads too).
 */
@Module({
  providers: [
    {
      provide: CACHE_STORE,
      inject: [ConfigService],
      // Its own connection, failing at once while Redis is down (a read falls back to Postgres).
      useFactory: (config: ConfigService<Env, true>) => {
        const url = config.get('REDIS_URL', { infer: true });
        // ioredis would fall back to localhost:6379 without a URL: refuse instead of guessing.
        if (!url) throw new Error('REDIS_URL is required by the cache');
        return new RedisCacheStore(producerConnection(url, CACHE_COMMAND_TIMEOUT_MS));
      },
    },
    {
      provide: CACHE_ENABLED,
      inject: [ConfigService],
      // Undefined only under a hand-made test config; the env schema defaults it to true.
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('CACHE_ENABLED', { infer: true }) ?? true,
    },
    {
      provide: EXTRACTION_CACHE_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ExtractionCacheOptions => ({
        resultTtlMs: DEFAULT_RESULT_TTL_MS,
        lockTtlMs:
          (config.get('AI_LLM_TIMEOUT_MS', { infer: true }) ?? DEFAULT_LLM_TIMEOUT_MS) +
          LOCK_MARGIN_MS,
        pollMs: DEFAULT_POLL_MS,
      }),
    },
    TenantReadCache,
    { provide: TENANT_CACHE_INVALIDATOR, useExisting: TenantReadCache },
    ExtractionResultCache,
  ],
  exports: [TenantReadCache, TENANT_CACHE_INVALIDATOR, ExtractionResultCache],
})
export class CacheModule {}
