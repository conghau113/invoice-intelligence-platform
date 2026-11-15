import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CACHE_ENABLED } from './application/cache-store.port';
import {
  DEFAULT_RESULT_TTL_MS,
  EXTRACTION_CACHE_OPTIONS,
  type ExtractionCacheOptions,
} from './application/extraction-result-cache';
import { CacheModule } from './cache.module';

/** The settings the module really builds (the integration test overrides them to run in seconds). */
async function options(env: Record<string, unknown>) {
  // Global like the app's ConfigModule.
  @Global()
  @Module({
    providers: [{ provide: ConfigService, useValue: { get: (k: string) => env[k] } }],
    exports: [ConfigService],
  })
  class FakeConfigModule {}
  const mod = await Test.createTestingModule({
    imports: [FakeConfigModule, CacheModule],
  }).compile();
  const built = {
    extraction: mod.get<ExtractionCacheOptions>(EXTRACTION_CACHE_OPTIONS),
    enabled: mod.get<boolean>(CACHE_ENABLED),
  };
  await mod.close();
  return built;
}

describe('CacheModule', () => {
  // Never connected: enableOfflineQueue is off and nothing is sent in these tests.
  const REDIS_URL = 'redis://127.0.0.1:1';

  it('keeps an extraction result 7 days and a lock 5 s longer than the AI timeout', async () => {
    const built = await options({ REDIS_URL, AI_LLM_TIMEOUT_MS: 60_000, CACHE_ENABLED: true });
    expect(DEFAULT_RESULT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(built.extraction.resultTtlMs).toBe(DEFAULT_RESULT_TTL_MS);
    expect(built.extraction.lockTtlMs).toBe(65_000);
  });

  it('CACHE_ENABLED=false reaches the caches', async () => {
    expect((await options({ REDIS_URL, CACHE_ENABLED: false })).enabled).toBe(false);
  });

  it('refuses to start without REDIS_URL', async () => {
    await expect(options({})).rejects.toThrow('REDIS_URL is required by the cache');
  });
});
