import { context, propagation, trace, type Attributes } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  TracerProvider,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry tracing for the API and the worker (T7.1, ADR 0015). Off unless
 * OTEL_EXPORTER_OTLP_ENDPOINT is set: tests, CI and a plain `pnpm dev:stack` start no SDK, and the
 * `@opentelemetry/api` calls in the app are then no-ops. The exporter reads the standard OTLP
 * variables itself (endpoint, headers with the Grafana Cloud token).
 *
 * Instrumented: incoming HTTP (+ Express routes), outgoing fetch (undici: the calls to the AI
 * service, which also carry `traceparent`) and Postgres. Deliberately not ioredis/BullMQ: the
 * worker polls Redis all the time, which would make a root span every few milliseconds.
 */

/** Attributes that may carry a query string: user input (search text, ids) never leaves in a span. */
const URL_ATTRIBUTES = ['url.full', 'http.url', 'http.target'];
const QUERY_ATTRIBUTE = 'url.query';
const REDACTED = 'REDACTED';
const EXCEPTION_EVENT = 'exception';
const EXCEPTION_TYPE = 'exception.type';
const ERROR_TYPE = 'error.type';

export function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Takes user input out of every span just before it ends, whatever library made it: query strings
 * from URL attributes, and error messages. Instrumentations (pg, http, express, undici) record an
 * `exception` event with message and stack and copy the message into the status; a Postgres
 * message can quote the value that was rejected. Only the error's type is kept, as `error.type`.
 */
export class RedactingProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: Span): void {
    const attributes: Attributes = span.attributes;
    for (const key of URL_ATTRIBUTES) {
      const value = attributes[key];
      if (typeof value === 'string') span.setAttribute(key, withoutQuery(value));
    }
    if (attributes[QUERY_ATTRIBUTE] !== undefined) span.setAttribute(QUERY_ATTRIBUTE, REDACTED);

    const exception = span.events.find((e) => e.name === EXCEPTION_EVENT);
    if (exception !== undefined) {
      const type = exception.attributes?.[EXCEPTION_TYPE];
      if (attributes[ERROR_TYPE] === undefined && typeof type === 'string') {
        span.setAttribute(ERROR_TYPE, type);
      }
      const kept = span.events.filter((e) => e.name !== EXCEPTION_EVENT);
      span.events.splice(0, span.events.length, ...kept);
    }
    // Same code, no message (setStatus keeps only what it is given).
    if (span.status.message !== undefined) span.setStatus({ code: span.status.code });
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Probes run every few seconds and say nothing about a request: no trace for them. */
const UNTRACED_PATHS = /^\/health(\/|$)/;

let provider: TracerProvider | undefined;
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

  provider = new TracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      'deployment.environment.name': env.NODE_ENV ?? 'development',
    }),
    // Order matters: the query is stripped before the batch processor hands the span on.
    spanProcessors: [
      new RedactingProcessor(),
      new BatchSpanProcessor({ exporter: exporter ?? new OTLPTraceExporter() }),
    ],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);

  unregister = registerInstrumentations({
    tracerProvider: provider,
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
