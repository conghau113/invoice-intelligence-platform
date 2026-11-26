import type { SpanExporter, TracerProvider } from '@opentelemetry/sdk-trace';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { registerTracerProvider } from 'telemetry';

/**
 * Tracing for the Next.js server (T7.1), loaded by `instrumentation.ts`. Next makes the request,
 * render and fetch spans itself and continues an incoming `traceparent`; it does not put one on
 * outgoing fetches, so the undici instrumentation does that: the API then joins the BFF route's
 * trace. The exporter reads the standard OTLP variables (endpoint, headers with the token).
 * The provider and its redaction come from the shared `telemetry` package, like apps/api/src/otel.ts;
 * only the instrumentation list is the web's own.
 */

let provider: TracerProvider | undefined;

/** `exporter` is for tests (in-memory); otherwise OTLP, configured from the environment. */
export function startTracing(serviceName: string, exporter?: SpanExporter): void {
  if (provider !== undefined) return;
  provider = registerTracerProvider(serviceName, process.env.NODE_ENV ?? 'development', exporter);
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [new UndiciInstrumentation()],
  });
  // No SIGTERM handler here: a listener would replace Node's default exit, and Next has no
  // shutdown hook for instrumentation. Spans of the last batch interval (5 s) before a stop are lost.
}

/** Exports the spans waiting in the batch now (tests read the exporter right after). */
export async function flushTracing(): Promise<void> {
  await provider?.forceFlush();
}
