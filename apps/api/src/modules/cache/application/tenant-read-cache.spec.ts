import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { generationKey } from '../domain/cache-keys';
import { MemoryCacheStore } from '../testing/memory-cache-store';
import { TenantReadCache, withJitter } from './tenant-read-cache';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const schema = z.strictObject({ n: z.int() });

describe('TenantReadCache', () => {
  let store: MemoryCacheStore;
  let cache: TenantReadCache;
  let loads: number;
  let value: number;
  const spec = (tenantId = ACME, params: Record<string, number> = { page: 1 }) => ({
    tenantId,
    name: 'documents-list' as const,
    params,
    schema,
    ttlMs: 30_000,
  });
  const load = () => {
    loads += 1;
    return Promise.resolve({ n: value });
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    store = new MemoryCacheStore();
    cache = new TenantReadCache(store, true);
    loads = 0;
    value = 1;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('loads once, then answers from the cache', async () => {
    expect(await cache.read(spec(), load)).toEqual({ n: 1 });
    value = 2;
    expect(await cache.read(spec(), load)).toEqual({ n: 1 });
    expect(loads).toBe(1);
    expect(store.counts.get('documents-list:miss')).toBe(1);
    expect(store.counts.get('documents-list:hit')).toBe(1);
  });

  it('after invalidate the next read loads the new data', async () => {
    await cache.read(spec(), load);
    value = 2;
    await cache.invalidate(ACME);
    expect(await cache.read(spec(), load)).toEqual({ n: 2 });
    expect(loads).toBe(2);
  });

  it("invalidating one tenant leaves the other's entries alone", async () => {
    await cache.read(spec(ACME), load);
    await cache.read(spec(GLOBEX), load);
    await cache.invalidate(ACME);
    await cache.read(spec(GLOBEX), load);
    expect(loads).toBe(2);
  });

  it("never answers one tenant with another tenant's entry", async () => {
    await cache.read(spec(ACME), load);
    value = 7;
    expect(await cache.read(spec(GLOBEX), load)).toEqual({ n: 7 });
  });

  it('a reader that loaded before a write committed stores under the old generation', async () => {
    // Reader reads the generation, then the database is slow; the writer commits and bumps.
    let release!: () => void;
    const slow = () =>
      new Promise<{ n: number }>((resolve) => {
        release = () => resolve({ n: 1 }); // the old rows
      });
    const reading = cache.read(spec(), slow);
    await new Promise((r) => setImmediate(r));
    value = 2;
    await cache.invalidate(ACME);
    release();
    expect(await reading).toEqual({ n: 1 });
    // The old rows were cached under generation 0; generation 1 readers load the new data.
    expect(await cache.read(spec(), load)).toEqual({ n: 2 });
  });

  it('concurrent misses on one key share one load (stampede)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowLoad = async () => {
      loads += 1;
      await gate;
      return { n: value };
    };
    const all = Promise.all([1, 2, 3, 4, 5].map(() => cache.read(spec(), slowLoad)));
    await new Promise((r) => setImmediate(r));
    release();
    expect(await all).toEqual(Array(5).fill({ n: 1 }));
    expect(loads).toBe(1);
    expect(store.counts.get('documents-list:coalesced')).toBe(4);
  });

  it('a value in Redis that does not parse is a miss, not an answer', async () => {
    await cache.read(spec(), load);
    for (const key of store.values.keys()) {
      if (key.includes('documents-list')) store.values.set(key, '{"n":"forged"}');
    }
    value = 3;
    expect(await cache.read(spec(), load)).toEqual({ n: 3 });
  });

  it('Redis down: every read goes to the database and nothing throws', async () => {
    store.down = true;
    expect(await cache.read(spec(), load)).toEqual({ n: 1 });
    expect(await cache.read(spec(), load)).toEqual({ n: 1 });
    expect(loads).toBe(2);
    await expect(cache.invalidate(ACME)).resolves.toBeUndefined();
    expect(store.counts.get('generation:error')).toBe(1);
  });

  it('a load that fails is not cached and the next read tries again', async () => {
    await expect(cache.read(spec(), () => Promise.reject(new Error('db')))).rejects.toThrow('db');
    expect(await cache.read(spec(), load)).toEqual({ n: 1 });
  });

  it('disabled: always loads, still bumps the generation', async () => {
    const off = new TenantReadCache(store, false);
    await off.read(spec(), load);
    await off.read(spec(), load);
    expect(loads).toBe(2);
    await off.invalidate(ACME);
    expect(store.values.get(generationKey(ACME))).toBe('1');
  });

  it('keeps the TTL within 10% below the asked value', () => {
    for (let i = 0; i < 200; i++) {
      const ttl = withJitter(30_000);
      expect(ttl).toBeGreaterThanOrEqual(27_000);
      expect(ttl).toBeLessThanOrEqual(30_000);
    }
  });
});
