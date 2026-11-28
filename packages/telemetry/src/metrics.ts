import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import type { Resource } from '@opentelemetry/resources';
import {
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
  createAllowListAttributesProcessor,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';

/**
 * The metrics setup the Node services share (T7.3, ADR 0015), pushed over OTLP like the traces.
 * Grafana Cloud Free counts active series (one per metric × label combination), so every metric
 * here keeps few labels and a histogram few buckets.
 */

/** Stable HTTP semantic convention, recorded by the http instrumentation itself (seconds). */
export const HTTP_SERVER_DURATION = 'http.server.request.duration';
/**
 * Seconds. 0.3 is NFR-02's p95 target, so the dashboard reads it from a bucket edge instead of an
 * interpolation; each bucket is one series per route × method × status.
 */
export const HTTP_DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.3, 0.5, 1, 2.5, 5, 10];
/** What a RED panel needs. Dropped: peer address, scheme, protocol version, user agent. */
export const HTTP_METRIC_ATTRIBUTES = [
  'http.request.method',
  'http.route',
  'http.response.status_code',
];
/** Every metric stays under this many label combinations; past it the SDK folds the rest into one. */
export const CARDINALITY_LIMIT = 500;
/** One data point per series per minute: the rate Grafana Cloud Free is priced on. */
export const EXPORT_INTERVAL_MS = 60_000;

/**
 * Creates the process's meter provider and makes it global, so the http instrumentation and every
 * `metrics.getMeter()` in the app record into it. `exporter` and `intervalMs` are for tests
 * (in-memory, short interval); otherwise OTLP, which reads the standard OTLP variables itself.
 */
export function registerMeterProvider(
  resource: Resource,
  exporter?: PushMetricExporter,
  intervalMs: number = EXPORT_INTERVAL_MS,
): MeterProvider {
  const provider = new MeterProvider({
    resource,
    views: [
      {
        instrumentName: HTTP_SERVER_DURATION,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: HTTP_DURATION_BUCKETS },
        },
        attributesProcessors: [createAllowListAttributesProcessor(HTTP_METRIC_ATTRIBUTES)],
      },
      // Outgoing calls (to the AI service, Keycloak's JWKS) are in the traces; not worth series here.
      {
        instrumentName: 'http.client.request.duration',
        aggregation: { type: AggregationType.DROP },
      },
    ],
    readers: [
      new PeriodicExportingMetricReader({
        exporter: exporter ?? new OTLPMetricExporter(),
        exportIntervalMillis: intervalMs,
        exportTimeoutMillis: Math.min(intervalMs, 30_000),
        cardinalityLimits: { default: CARDINALITY_LIMIT },
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  return provider;
}
