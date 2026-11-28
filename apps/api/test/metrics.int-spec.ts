/**
 * Queue and cache gauges (T7.3) against a real Redis in a container: BullMQ's own counts, which
 * waiting job is next and how long it stays there, the shared `cache:stats` hash, a source that is
 * shut down, and a Redis that goes away.
 */
import type { ConfigService } from '@nestjs/config';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import type { Env } from '../src/config/env.schema';
import { STATS_KEY } from '../src/modules/cache/domain/cache-keys';
import { registerOperationalMetrics } from '../src/modules/metrics/application/operational-metrics';
import { RedisMetricsSource } from '../src/modules/metrics/infra/redis-metrics-source';
import { EXTRACTION_QUEUE } from '../src/modules/queue/domain/extraction-job';
import { INDEX_QUEUE } from '../src/modules/search/domain/index-job';
import { startRedis } from './support/reachable-container';

describe('queue and cache gauges (real Redis)', () => {
  let container: StartedTestContainer;
  let url: string;
  let redis: Redis;
  let source: RedisMetricsSource;
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  let provider: MeterProvider;
  let stopped = false;
  // The head age is measured with this clock, so a test moves time instead of waiting.
  let clock = Date.now();

  beforeAll(async () => {
    container = await startRedis();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    redis = new Redis(url);
    source = new RedisMetricsSource({ get: () => url } as unknown as ConfigService<Env, true>);
    provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
    });
    registerOperationalMetrics(provider.getMeter('test'), source, () => clock);
  }, 120_000);

  afterAll(async () => {
    await provider.shutdown();
    await source.onApplicationShutdown();
    redis.disconnect();
    if (!stopped) await container.stop();
  });

  const collect = async (): Promise<Map<string, MetricData>> => {
    exporter.reset();
    await provider.forceFlush();
    const all = exporter
      .getMetrics()
      .flatMap((r) => r.scopeMetrics)
      .flatMap((s) => s.metrics);
    return new Map(all.map((m) => [m.descriptor.name, m]));
  };
  const value = (m: MetricData | undefined, attributes: Record<string, string>) =>
    m?.dataPoints.find((p) => JSON.stringify(p.attributes) === JSON.stringify(attributes))?.value;

  it('says the queues were read', async () => {
    expect(value((await collect()).get('queue.reachable'), {})).toBe(1);
  });

  it('reads the job counts, and ages the head of the queue from when it is first seen', async () => {
    const extraction = new Queue(EXTRACTION_QUEUE, { connection: redis });
    const index = new Queue(INDEX_QUEUE, { connection: redis });
    // Created 10 minutes ago, like a failed job an admin retries now: BullMQ keeps that creation
    // time, which must not count as 10 minutes stuck (code review T7.3).
    await extraction.add('extract', {}, { jobId: 'retried', timestamp: Date.now() - 600_000 });
    await extraction.add('extract', {}, { jobId: 'newer' });
    await extraction.add('extract', {}, { jobId: 'later', delay: 60_000 });
    await index.add('index', {}, { jobId: 'one' });
    const headAge = async () =>
      value((await collect()).get('queue.head_wait.age'), { queue: EXTRACTION_QUEUE });

    const metrics = await collect();
    const jobs = metrics.get('queue.jobs');
    expect(value(jobs, { queue: EXTRACTION_QUEUE, state: 'waiting' })).toBe(2);
    expect(value(jobs, { queue: EXTRACTION_QUEUE, state: 'delayed' })).toBe(1);
    expect(value(jobs, { queue: INDEX_QUEUE, state: 'waiting' })).toBe(1);
    expect(value(jobs, { queue: INDEX_QUEUE, state: 'failed' })).toBe(0);
    expect(value(metrics.get('queue.head_wait.age'), { queue: EXTRACTION_QUEUE })).toBe(0);

    // Nobody takes it: the same job stays at the head.
    clock += 120_000;
    expect(await headAge()).toBe(120);

    // A worker takes the head job: the next one is new at the head.
    const taken = await extraction.getJobs(['waiting'], 0, 0, true);
    expect(taken[0]?.id).toBe('retried'); // first in, first out
    await taken[0]?.remove();
    clock += 60_000;
    expect(await headAge()).toBe(0);

    await extraction.obliterate({ force: true });
    await index.obliterate({ force: true });
    await extraction.close();
    await index.close();
    clock += 60_000;
    expect(await headAge()).toBe(0);
  });

  it('reads the shared cache counters', async () => {
    await redis.hincrby(STATS_KEY, 'documents-list:hit', 3);
    await redis.hincrby(STATS_KEY, 'documents-list:miss', 1);

    const cache = (await collect()).get('cache.requests');
    expect(value(cache, { cache: 'documents-list', outcome: 'hit' })).toBe(3);
    expect(value(cache, { cache: 'documents-list', outcome: 'miss' })).toBe(1);
  });

  it('reports nothing and opens no connection again once shut down (the collection at exit)', async () => {
    const late = new RedisMetricsSource({ get: () => url } as unknown as ConfigService<Env, true>);
    await late.queues();
    await late.onApplicationShutdown();
    try {
      await expect(late.queues()).resolves.toBeNull();
      await expect(late.cacheCounters()).resolves.toBeNull();
    } finally {
      // Should the read have reopened a connection, close it: a leak would hang jest, not fail it.
      await late.onApplicationShutdown();
    }
  });

  // Last: Redis does not come back.
  it('keeps ageing a stuck head while Redis is down and marks the numbers stale', async () => {
    const extraction = new Queue(EXTRACTION_QUEUE, { connection: redis });
    await extraction.add('extract', {}, { jobId: 'stuck' });
    await extraction.close();
    await collect(); // head seen
    clock += 60_000;
    await collect();

    await container.stop();
    stopped = true;
    clock += 300_000;
    const started = Date.now();
    const metrics = await collect();
    expect(value(metrics.get('queue.reachable'), {})).toBe(0);
    expect(value(metrics.get('queue.head_wait.age'), { queue: EXTRACTION_QUEUE })).toBe(360);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});
