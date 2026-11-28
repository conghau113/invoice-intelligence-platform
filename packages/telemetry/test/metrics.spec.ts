import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type HistogramMetricData,
  type MeterProvider,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import {
  HTTP_DURATION_BUCKETS,
  HTTP_SERVER_DURATION,
  registerMeterProvider,
  serviceResource,
} from '../src';

describe('registerMeterProvider', () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  let provider: MeterProvider;

  beforeAll(() => {
    // A long interval: the test exports by hand with forceFlush.
    provider = registerMeterProvider(serviceResource('invoice-test', 'test'), exporter, 3_600_000);
  });
  afterAll(async () => {
    await provider.shutdown();
    metrics.disable();
  });
  beforeEach(() => exporter.reset());

  const collect = async (): Promise<MetricData[]> => {
    await provider.forceFlush();
    return exporter
      .getMetrics()
      .flatMap((r) => r.scopeMetrics)
      .flatMap((s) => s.metrics);
  };

  it('is the global provider and carries the service name', async () => {
    metrics.getMeter('test').createCounter('work.done').add(1);
    await provider.forceFlush();
    const [resourceMetrics] = exporter.getMetrics();
    expect(resourceMetrics?.resource.attributes['service.name']).toBe('invoice-test');
  });

  it('keeps only method, route and status on the HTTP server histogram, in few buckets', async () => {
    const histogram = metrics.getMeter('http').createHistogram(HTTP_SERVER_DURATION);
    histogram.record(0.2, {
      'http.request.method': 'GET',
      'http.route': '/documents/:id',
      'http.response.status_code': 200,
      'server.address': 'api.internal',
      'user_agent.original': 'curl/8',
    });

    const metric = (await collect()).find(
      (m) => m.descriptor.name === HTTP_SERVER_DURATION,
    ) as HistogramMetricData;
    const [point] = metric.dataPoints;
    expect(point?.attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/documents/:id',
      'http.response.status_code': 200,
    });
    expect(point?.value.buckets.boundaries).toEqual(HTTP_DURATION_BUCKETS);
  });

  it('drops the HTTP client histogram', async () => {
    metrics.getMeter('http').createHistogram('http.client.request.duration').record(0.1);
    const names = (await collect()).map((m) => m.descriptor.name);
    expect(names).not.toContain('http.client.request.duration');
  });
});
