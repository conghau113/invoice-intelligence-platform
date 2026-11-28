import { context, propagation, trace, type Attributes } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  TracerProvider,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * The tracing setup the Node services share (T7.1, ADR 0015): API, worker and the Next.js server.
 * Each service adds only its own instrumentations. The exporter reads the standard OTLP variables
 * itself (endpoint, headers with the Grafana Cloud token).
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

/** Who sends the telemetry: shared by the tracer and the meter provider of one process. */
export function serviceResource(serviceName: string, environment: string): Resource {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    'deployment.environment.name': environment,
  });
}

/**
 * Creates the process's tracer provider and makes it global, with the W3C propagator and an
 * async-hooks context (the active span follows `await`). `exporter` is for tests (in-memory);
 * otherwise OTLP. The caller registers its instrumentations against the returned provider.
 */
export function registerTracerProvider(
  serviceName: string,
  environment: string,
  exporter?: SpanExporter,
): TracerProvider {
  const provider = new TracerProvider({
    resource: serviceResource(serviceName, environment),
    // Order matters: user input is removed before the batch processor hands the span on.
    spanProcessors: [
      new RedactingProcessor(),
      new BatchSpanProcessor({ exporter: exporter ?? new OTLPTraceExporter() }),
    ],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  return provider;
}

export * from './metrics';
