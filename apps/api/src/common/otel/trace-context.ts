import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
} from '@opentelemetry/api';

const tracer = trace.getTracer('invoice-api');

/**
 * The `traceparent` of the span running now, to store in a job so the worker continues this
 * trace (T7.1). `undefined` when tracing is off (no SDK: the API calls are no-ops) or no span is
 * active; the caller then keeps whatever it had before.
 */
export function activeTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

/** What a failed job span records: a code or an error class, never a message (may hold content). */
function errorType(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as Error & { code?: unknown }).code;
    return typeof code === 'string' ? code : e.name;
  }
  return 'error';
}

/**
 * Runs one queue job inside a CONSUMER span whose parent is the `traceparent` the producer stored
 * in the job data. Everything the job does (Postgres, the call to the AI service) then joins the
 * upload's trace. Without a valid traceparent the span starts a new trace.
 */
export function runInConsumerSpan<T>(
  name: string,
  traceparent: unknown,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  // The W3C propagator validates the format itself; anything else is ignored.
  const parent =
    typeof traceparent === 'string'
      ? propagation.extract(ROOT_CONTEXT, { traceparent })
      : ROOT_CONTEXT;
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.CONSUMER, attributes },
    parent,
    async (span) => {
      try {
        return await fn();
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute('error.type', errorType(e));
        throw e;
      } finally {
        span.end();
      }
    },
  );
}
