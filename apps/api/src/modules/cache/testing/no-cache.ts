import { ExtractionResultCache } from '../application/extraction-result-cache';
import { TenantReadCache } from '../application/tenant-read-cache';
import { MemoryCacheStore } from './memory-cache-store';

/** For code built by hand in tests about something else: every read loads, every AI call happens. */
export const disabledReadCache = (): TenantReadCache =>
  new TenantReadCache(new MemoryCacheStore(), false);

export const disabledResultCache = (): ExtractionResultCache =>
  new ExtractionResultCache(new MemoryCacheStore(), false, {
    resultTtlMs: 1,
    lockTtlMs: 1,
    pollMs: 1,
  });
