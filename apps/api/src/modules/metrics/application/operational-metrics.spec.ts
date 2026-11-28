import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import {
  QueueHeads,
  parseCacheCounters,
  registerOperationalMetrics,
  type MetricsSource,
  type QueueSnapshot,
} from './operational-metrics';

const START = 1_800_000_000_000;
let clock = START;

function setup(source: MetricsSource) {
  clock = START;
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
  });
  registerOperationalMetrics(provider.getMeter('test'), source, () => clock);
  const collect = async (): Promise<Map<string, MetricData>> => {
    exporter.reset();
    await provider.forceFlush();
    const all = exporter
      .getMetrics()
      .flatMap((r) => r.scopeMetrics)
      .flatMap((s) => s.metrics);
    return new Map(all.map((m) => [m.descriptor.name, m]));
  };
  return { provider, collect };
}

const points = (m: MetricData | undefined) =>
  (m?.dataPoints ?? []).map((p) => [p.attributes, p.value]);

const extraction: QueueSnapshot = {
  queue: 'extraction',
  counts: { waiting: 3, active: 1, delayed: 2, failed: 4 },
  headJobId: 'doc-1',
};
const index: QueueSnapshot = {
  queue: 'rag-index',
  counts: { waiting: 0, active: 0, delayed: 0, failed: 0 },
  headJobId: null,
};
const HEAD_AGE = 'queue.head_wait.age';

describe('registerOperationalMetrics', () => {
  it('reports jobs per queue and state', async () => {
    const { provider, collect } = setup({
      queues: () => Promise.resolve([extraction, index]),
      cacheCounters: () => Promise.resolve({}),
    });
    const metrics = await collect();

    expect(points(metrics.get('queue.jobs'))).toEqual(
      expect.arrayContaining([
        [{ queue: 'extraction', state: 'waiting' }, 3],
        [{ queue: 'extraction', state: 'active' }, 1],
        [{ queue: 'extraction', state: 'delayed' }, 2],
        [{ queue: 'extraction', state: 'failed' }, 4],
        [{ queue: 'rag-index', state: 'waiting' }, 0],
      ]),
    );
    await provider.shutdown();
  });

  it('ages the head while the same job stays next, and resets when it moves', async () => {
    let head: string | null = 'doc-1';
    const { provider, collect } = setup({
      queues: () => Promise.resolve([{ ...extraction, headJobId: head }]),
      cacheCounters: () => Promise.resolve({}),
    });
    const age = async () => points((await collect()).get(HEAD_AGE));

    expect(await age()).toEqual([[{ queue: 'extraction' }, 0]]); // first seen now
    clock += 60_000;
    expect(await age()).toEqual([[{ queue: 'extraction' }, 60]]);
    clock += 300_000;
    expect(await age()).toEqual([[{ queue: 'extraction' }, 360]]);
    head = 'doc-2'; // a worker took doc-1
    clock += 60_000;
    expect(await age()).toEqual([[{ queue: 'extraction' }, 0]]);
    head = null; // nothing waits
    clock += 60_000;
    expect(await age()).toEqual([[{ queue: 'extraction' }, 0]]);
    await provider.shutdown();
  });

  it('reports the cache counters, with known names and outcomes only', async () => {
    const { provider, collect } = setup({
      queues: () => Promise.resolve([]),
      cacheCounters: () =>
        Promise.resolve({
          'documents-list:hit': '7',
          'documents-list:miss': '2',
          'generation:error': '1',
          'someone-else:hit': '5',
          'documents-list:exploded': '1',
          'insights-online:hit': 'NaN',
        }),
    });
    const metrics = await collect();

    expect(points(metrics.get('cache.requests'))).toEqual([
      [{ cache: 'documents-list', outcome: 'hit' }, 7],
      [{ cache: 'documents-list', outcome: 'miss' }, 2],
      [{ cache: 'generation', outcome: 'error' }, 1],
    ]);
    await provider.shutdown();
  });

  it('keeps ageing a waiting head while Redis cannot be read, and says the numbers are stale', async () => {
    let fail = false;
    const { provider, collect } = setup({
      queues: () =>
        fail ? Promise.reject(new Error('Redis timeout')) : Promise.resolve([extraction]),
      cacheCounters: () => Promise.resolve({ 'documents-list:hit': '1' }),
    });
    expect(points((await collect()).get('queue.reachable'))).toEqual([[{}, 1]]);

    fail = true;
    clock += 400_000;
    const metrics = await collect();
    expect(points(metrics.get('queue.reachable'))).toEqual([[{}, 0]]);
    // Code review T7.3: a frozen age would hide a stuck job behind a dead Redis.
    expect(points(metrics.get(HEAD_AGE))).toEqual([[{ queue: 'extraction' }, 400]]);
    // Counts are not observed; the SDK repeats the last value (cumulative export): 3, not 0.
    expect(points(metrics.get('queue.jobs'))).toContainEqual([
      { queue: 'extraction', state: 'waiting' },
      3,
    ]);
    expect(points(metrics.get('cache.requests'))).toHaveLength(1);
    await provider.shutdown();
  });

  it('observes no queue series when the very first read fails', async () => {
    const { provider, collect } = setup({
      queues: () => Promise.reject(new Error('Redis timeout')),
      cacheCounters: () => Promise.resolve({}),
    });
    const metrics = await collect();
    expect(points(metrics.get('queue.jobs'))).toEqual([]);
    expect(points(metrics.get(HEAD_AGE))).toEqual([]);
    expect(points(metrics.get('queue.reachable'))).toEqual([[{}, 0]]);
    await provider.shutdown();
  });

  it('observes nothing once the source is shut down, not "Redis unreachable"', async () => {
    const { provider, collect } = setup({
      queues: () => Promise.resolve(null),
      cacheCounters: () => Promise.resolve(null),
    });
    const metrics = await collect();
    expect(points(metrics.get('queue.reachable'))).toEqual([]);
    expect(points(metrics.get('cache.requests'))).toEqual([]);
    await provider.shutdown();
  });

  it('never reads the source when no reader collects', () => {
    const queues = jest.fn(() => Promise.resolve([]));
    const cacheCounters = jest.fn(() => Promise.resolve({}));
    const provider = new MeterProvider();
    registerOperationalMetrics(provider.getMeter('test'), { queues, cacheCounters });
    expect(queues).not.toHaveBeenCalled();
    expect(cacheCounters).not.toHaveBeenCalled();
  });
});

describe('QueueHeads', () => {
  it('tracks each queue on its own', () => {
    const heads = new QueueHeads();
    heads.seen('a', 'x', 0);
    heads.seen('b', 'y', 1_000);
    expect(heads.seen('a', 'x', 5_000)).toBe(5_000);
    expect(heads.unread(9_000)).toEqual([
      { queue: 'a', ageMs: 9_000 },
      { queue: 'b', ageMs: 8_000 },
    ]);
  });
});

describe('parseCacheCounters', () => {
  it('skips a field without a cache name or with a negative or fractional count', () => {
    expect(
      parseCacheCounters({
        ':hit': '1',
        'documents-list:hit': '-1',
        'extraction-result:hit': '1.5',
      }),
    ).toEqual([]);
  });
});
