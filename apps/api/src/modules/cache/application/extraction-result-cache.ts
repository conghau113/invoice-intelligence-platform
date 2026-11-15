import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  aiExtractResponseSchema,
  type AiExtractResponse,
} from '../../extraction/domain/ai-extract-response';
import {
  EXTRACTION_CACHE,
  extractionKey,
  extractionLockKey,
  isExtractionVersion,
  type ExtractionVersion,
} from '../domain/cache-keys';
import { CACHE_ENABLED, CACHE_STORE, type CacheStore } from './cache-store.port';

export const EXTRACTION_CACHE_OPTIONS = Symbol('EXTRACTION_CACHE_OPTIONS');

export interface ExtractionCacheOptions {
  /** How long a result is kept. It holds invoice data (PII): keep it bounded (SECURITY.md). */
  resultTtlMs: number;
  /** How long the lock lives if its holder dies: at least the worker's own AI timeout. */
  lockTtlMs: number;
  /** How often a waiting worker looks for the holder's result. */
  pollMs: number;
}

export const DEFAULT_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_POLL_MS = 250;

export interface CacheLookup {
  tenantId: string;
  contentHash: string;
  /**
   * GET /extract/version, asked only while the cache is on (no extra request otherwise); null when
   * the AI service did not say, and then there is no cache for this attempt.
   */
  version: () => Promise<ExtractionVersion | null>;
}

export interface ExtractionOutcome {
  result: AiExtractResponse;
  /** true when no model was called for this attempt. */
  fromCache: boolean;
}

/**
 * Result cache of the LLM path (ADR 0013): the same bytes, model, prompt and pipeline code give the
 * same extraction, so a second attempt reuses the first answer instead of paying for another call.
 * In this product a tenant cannot have two documents with the same bytes (UNIQUE tenant_id,
 * content_hash), so what it saves is the attempt after the AI answered: a job delivered twice at
 * once (Phát sinh T2.9) or retried because the database write after the call failed.
 *
 * Coalescing: the first attempt takes a lock (SET NX PX) and calls the AI; another attempt for the
 * same key waits for that result instead of calling too, until the lock is gone. Redis down, or no
 * version: the AI is called as if there were no cache. What comes back from Redis is parsed with the
 * same schema as an AI answer; anything else is a miss.
 */
@Injectable()
export class ExtractionResultCache {
  constructor(
    @Inject(CACHE_STORE) private readonly store: CacheStore,
    @Inject(CACHE_ENABLED) private readonly enabled: boolean,
    @Inject(EXTRACTION_CACHE_OPTIONS) private readonly options: ExtractionCacheOptions,
  ) {}

  async getOrCall(
    lookup: CacheLookup,
    call: () => Promise<AiExtractResponse>,
  ): Promise<ExtractionOutcome> {
    const fresh = async () => ({ result: await call(), fromCache: false });
    if (!this.enabled) return fresh();
    const version = await lookup.version();
    if (version === null || !isExtractionVersion(version)) return fresh();
    const key = extractionKey(lookup.tenantId, lookup.contentHash, version);
    const lockKey = extractionLockKey(key);
    const token = randomUUID();

    let locked: boolean;
    try {
      const cached = await this.find(key);
      if (cached !== undefined) {
        this.store.count(EXTRACTION_CACHE, 'hit');
        return { result: cached, fromCache: true };
      }
      locked = await this.store.setIfAbsent(lockKey, token, this.options.lockTtlMs);
    } catch {
      this.store.count(EXTRACTION_CACHE, 'error');
      return fresh();
    }

    if (!locked) {
      const shared = await this.waitForHolder(key, lockKey);
      if (shared !== undefined) {
        this.store.count(EXTRACTION_CACHE, 'coalesced');
        return { result: shared, fromCache: true };
      }
      // The holder failed or gave up: call ourselves, without the lock (we only lose coalescing).
    }
    this.store.count(EXTRACTION_CACHE, 'miss');
    try {
      const result = await call();
      if (sameVersion(result, version)) {
        await this.store
          .set(key, JSON.stringify(result), this.options.resultTtlMs)
          .catch(() => undefined);
      } else {
        this.store.count(EXTRACTION_CACHE, 'skipped');
      }
      return { result, fromCache: false };
    } finally {
      if (locked) await this.store.deleteIfEquals(lockKey, token).catch(() => undefined);
    }
  }

  private async find(key: string): Promise<AiExtractResponse | undefined> {
    const raw = await this.store.get(key);
    if (raw === null) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = aiExtractResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
  }

  /** The holder's result, or undefined once its lock is gone without one (or Redis is). */
  private async waitForHolder(
    key: string,
    lockKey: string,
  ): Promise<AiExtractResponse | undefined> {
    const deadline = Date.now() + this.options.lockTtlMs;
    try {
      while (Date.now() < deadline) {
        await sleep(this.options.pollMs);
        const result = await this.find(key);
        if (result !== undefined) return result;
        if ((await this.store.get(lockKey)) === null) return this.find(key);
      }
    } catch {
      this.store.count(EXTRACTION_CACHE, 'error');
    }
    return undefined;
  }
}

/**
 * Only an answer of the model and prompt the key names is stored: an answer from another model
 * (a deploy in between) would otherwise be served as if it came from the one in the key.
 */
function sameVersion(result: AiExtractResponse, version: ExtractionVersion): boolean {
  return (
    result.usage !== null &&
    result.usage.model === version.model &&
    result.usage.promptVersion === version.promptVersion
  );
}
