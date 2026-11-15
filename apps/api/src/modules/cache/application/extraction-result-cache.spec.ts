import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AiExtractResponse } from '../../extraction/domain/ai-extract-response';
import { extractionKey, extractionLockKey } from '../domain/cache-keys';
import { MemoryCacheStore } from '../testing/memory-cache-store';
import { ExtractionResultCache } from './extraction-result-cache';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const HASH = 'a'.repeat(64);
const VERSION = {
  model: 'gemini-test',
  promptVersion: 'invoice_extraction/v1',
  pipelineVersion: 'b'.repeat(64),
};
const INVOICE = JSON.parse(
  readFileSync(
    path.join(__dirname, '../../../../../../packages/contracts/fixtures/invoice.valid.json'),
    'utf8',
  ),
) as AiExtractResponse['invoice'];
const ANSWER: AiExtractResponse = {
  invoice: INVOICE,
  warnings: [],
  usage: {
    model: VERSION.model,
    promptVersion: VERSION.promptVersion,
    inputTokens: 1500,
    outputTokens: 800,
    latencyMs: 3200,
    costUsd: 0.0016,
  },
};
const OPTIONS = { resultTtlMs: 60_000, lockTtlMs: 500, pollMs: 5 };

describe('ExtractionResultCache', () => {
  let store: MemoryCacheStore;
  let cache: ExtractionResultCache;
  let calls: number;
  const call = () => {
    calls += 1;
    return Promise.resolve(ANSWER);
  };
  const lookup = (tenantId = ACME, version: typeof VERSION | null = VERSION) => ({
    tenantId,
    contentHash: HASH,
    version: () => Promise.resolve(version),
  });

  beforeEach(() => {
    store = new MemoryCacheStore();
    cache = new ExtractionResultCache(store, true, OPTIONS);
    calls = 0;
  });

  it('calls the AI once for the same bytes, model, prompt and pipeline', async () => {
    expect(await cache.getOrCall(lookup(), call)).toEqual({ result: ANSWER, fromCache: false });
    expect(await cache.getOrCall(lookup(), call)).toEqual({ result: ANSWER, fromCache: true });
    expect(calls).toBe(1);
    expect(store.ttls.get(extractionKey(ACME, HASH, VERSION))).toBe(OPTIONS.resultTtlMs);
  });

  it('releases its lock after the call', async () => {
    await cache.getOrCall(lookup(), call);
    expect(store.values.has(extractionLockKey(extractionKey(ACME, HASH, VERSION)))).toBe(false);
  });

  it("another tenant's identical file is a miss (no cross-tenant reuse)", async () => {
    await cache.getOrCall(lookup(ACME), call);
    expect((await cache.getOrCall(lookup(GLOBEX), call)).fromCache).toBe(false);
    expect(calls).toBe(2);
  });

  it('a new pipeline version is a miss', async () => {
    await cache.getOrCall(lookup(), call);
    await cache.getOrCall(lookup(ACME, { ...VERSION, pipelineVersion: 'c'.repeat(64) }), call);
    expect(calls).toBe(2);
  });

  it('two attempts at once: the second waits for the first answer instead of calling', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async () => {
      calls += 1;
      await gate;
      return ANSWER;
    };
    const first = cache.getOrCall(lookup(), slow);
    await new Promise((r) => setImmediate(r));
    const second = cache.getOrCall(lookup(), slow);
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await first).fromCache).toBe(false);
    expect((await second).fromCache).toBe(true);
    expect(calls).toBe(1);
    expect(store.counts.get('extraction-result:coalesced')).toBe(1);
  });

  it('the holder fails: the waiting attempt calls the AI itself', async () => {
    let fail!: () => void;
    const failing = new Promise<AiExtractResponse>((_r, reject) => {
      fail = () => reject(new Error('AI down'));
    });
    const first = cache.getOrCall(lookup(), () => failing);
    await new Promise((r) => setImmediate(r));
    const second = cache.getOrCall(lookup(), call);
    await new Promise((r) => setTimeout(r, 20));
    fail();
    await expect(first).rejects.toThrow('AI down');
    expect(await second).toEqual({ result: ANSWER, fromCache: false });
    expect(calls).toBe(1);
  });

  it('a lock left by a dead worker stops blocking after its TTL', async () => {
    const lockKey = extractionLockKey(extractionKey(ACME, HASH, VERSION));
    store.values.set(lockKey, 'dead-worker');
    // The memory store has no clock; drop the lock like Redis would when the TTL ends.
    setTimeout(() => store.values.delete(lockKey), 30);
    const started = Date.now();
    expect((await cache.getOrCall(lookup(), call)).fromCache).toBe(false);
    expect(Date.now() - started).toBeLessThan(OPTIONS.lockTtlMs);
    expect(calls).toBe(1);
  });

  it('does not store an answer from another model than the key names', async () => {
    const other = { ...ANSWER, usage: { ...ANSWER.usage!, model: 'fallback-model' } };
    await cache.getOrCall(lookup(), () => Promise.resolve(other));
    expect(store.values.has(extractionKey(ACME, HASH, VERSION))).toBe(false);
    expect(store.counts.get('extraction-result:skipped')).toBe(1);
  });

  it('a cached value that is not a valid answer is a miss', async () => {
    store.values.set(extractionKey(ACME, HASH, VERSION), JSON.stringify({ invoice: {}, x: 1 }));
    expect((await cache.getOrCall(lookup(), call)).fromCache).toBe(false);
    expect(calls).toBe(1);
  });

  it('no version from the AI service: calls without the cache', async () => {
    await cache.getOrCall(lookup(ACME, null), call);
    await cache.getOrCall(lookup(ACME, null), call);
    expect(calls).toBe(2);
    expect(store.values.size).toBe(0);
  });

  it('Redis down: calls the AI and does not throw a cache error', async () => {
    store.down = true;
    expect(await cache.getOrCall(lookup(), call)).toEqual({ result: ANSWER, fromCache: false });
    expect(store.counts.get('extraction-result:error')).toBe(1);
  });

  it('disabled: always calls, and does not even ask the AI service for its version', async () => {
    const off = new ExtractionResultCache(store, false, OPTIONS);
    const asked = jest.fn(() => Promise.resolve(VERSION));
    await off.getOrCall({ tenantId: ACME, contentHash: HASH, version: asked }, call);
    await off.getOrCall({ tenantId: ACME, contentHash: HASH, version: asked }, call);
    expect(calls).toBe(2);
    expect(asked).not.toHaveBeenCalled();
  });
});
