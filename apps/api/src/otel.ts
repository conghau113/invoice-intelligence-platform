import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import type { MeterProvider, PushMetricExporter } from '@opentelemetry/sdk-metrics';
import type { SpanExporter, TracerProvider } from '@opentelemetry/sdk-trace';
import { registerMeterProvider, registerTracerProvider, serviceResource } from 'telemetry';

/**
 * OpenTelemetry tracing for the API and the worker (T7.1, ADR 0015). Off unless
 * OTEL_EXPORTER_OTLP_ENDPOINT is set: tests, CI and a plain `pnpm dev:stack` start no SDK, and the
 * `@opentelemetry/api` calls in the app are then no-ops. The exporter reads the standard OTLP
 * variables itself (endpoint, headers with the Grafana Cloud token).
 *
 * Instrumented: incoming HTTP (+ Express routes), outgoing fetch (undici: the calls to the AI
 * service, which also carry `traceparent`) and Postgres. Deliberately not ioredis/BullMQ: the
 * worker polls Redis all the time, which would make a root span every few milliseconds. The
 * provider and what it removes from every span (query strings, error messages) live in the shared
 * `telemetry` package.
 *
 * Metrics (T7.3) start under the same condition, in the API process only: RED metrics from the
 * http instrumentation, plus the queue and cache gauges of `QueueMetrics`. The worker has none: the
 * queue is measured from the API so a dead worker still shows up as a growing queue.
 */

/** Probes run every few seconds and say nothing about a request: no trace for them. */
const UNTRACED_PATHS = /^\/health(\/|$)/;

let provider: TracerProvider | undefined;
/** Metrics (T7.3): the API only; started before tracing so the http instrumentation records into it. */
let meterProvider: MeterProvider | undefined;
/** Removes the instrumentations again (registerInstrumentations' return value). */
let unregister: (() => void) | undefined;

/**
 * Starts tracing for this process. Must run before Nest, `http` or `pg` are loaded, so the
 * instrumentations can patch them: hence the side-effect entries `otel-api.ts`/`otel-worker.ts`
 * imported first by `main.ts`/`worker.ts`. `exporter` is for tests (in-memory).
 */
export function startTracing(
  serviceName: string,
  env: NodeJS.ProcessEnv = process.env,
  exporter?: SpanExporter,
): boolean {
  if (provider !== undefined) return true;
  if (exporter === undefined && !env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;

  provider = registerTracerProvider(serviceName, env.NODE_ENV ?? 'development', exporter);

  unregister = registerInstrumentations({
    tracerProvider: provider,
    // RED metrics (`http.server.request.duration`) come from the same http instrumentation; probes
    // ignored above are neither traced nor counted.
    ...(meterProvider === undefined ? {} : { meterProvider }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => UNTRACED_PATHS.test(req.url ?? ''),
      }),
      new ExpressInstrumentation(),
      new UndiciInstrumentation(),
      // Statement text only (parameterised by Drizzle); values stay out (no enhanced reporting).
      // Only queries inside a request or job span: a health probe's `SELECT 1` (its request is not
      // traced) would otherwise be a trace of its own every few seconds.
      new PgInstrumentation({ enhancedDatabaseReporting: false, requireParentSpan: true }),
    ],
  });
  return true;
}

/**
 * Starts metrics for this process (T7.3), under the same condition as tracing. Call before
 * `startTracing`. `exporter`/`intervalMs` are for tests (in-memory, short interval).
 */
export function startMetrics(
  serviceName: string,
  env: NodeJS.ProcessEnv = process.env,
  exporter?: PushMetricExporter,
  intervalMs?: number,
): boolean {
  if (meterProvider !== undefined) return true;
  if (exporter === undefined && !env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  meterProvider = registerMeterProvider(
    serviceResource(serviceName, env.NODE_ENV ?? 'development'),
    exporter,
    intervalMs,
  );
  return true;
}

/** Collects and exports every metric now (tests read the exporter right after). */
export async function flushMetrics(): Promise<void> {
  await meterProvider?.forceFlush();
}

/** Sends the last values, then takes metrics down. Called on shutdown; never throws. */
export async function stopMetrics(): Promise<void> {
  const current = meterProvider;
  if (current === undefined) return;
  meterProvider = undefined;
  await current.shutdown().catch(() => undefined);
  metrics.disable();
}

/** Exports the spans waiting in the batch now (tests read the exporter right after). */
export async function flushTracing(): Promise<void> {
  await provider?.forceFlush();
}

/**
 * Sends the spans still in the batch, then takes tracing down: the fetch instrumentation listens on
 * a process-wide diagnostics channel and would otherwise keep adding `traceparent` headers. Called
 * on shutdown; never throws.
 */
export async function stopTracing(): Promise<void> {
  const current = provider;
  if (current === undefined) return;
  provider = undefined;
  unregister?.();
  unregister = undefined;
  await current.shutdown().catch(() => undefined);
  trace.disable();
  propagation.disable();
  context.disable();
}
