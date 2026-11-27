import { trace } from '@opentelemetry/api';
import pino, {
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type Level,
  type Logger,
} from 'pino';
import { currentLogContext } from './context';
import { redactValue } from './redact';

export type { Logger } from 'pino';

export interface LoggerOptions {
  /** Same value as the service's OTel `service.name` (invoice-api, invoice-worker...). */
  service: string;
  level?: Level | 'silent';
  /** Tests: where the JSON lines go. Default: stdout, written synchronously. */
  destination?: DestinationStream;
}

/** The ids that tie a log line to its trace and tenant. Absent when tracing is off. */
export function correlationFields(): Record<string, string> {
  const fields: Record<string, string> = {};
  const span = trace.getActiveSpan()?.spanContext();
  if (span !== undefined && trace.isSpanContextValid(span)) {
    fields.trace_id = span.traceId;
    fields.span_id = span.spanId;
  }
  const { tenantId } = currentLogContext();
  if (tenantId !== undefined) fields.tenant_id = tenantId;
  return fields;
}

/**
 * The one logger config of the Node services (T7.2): JSON lines with `service`, `trace_id`,
 * `span_id` and `tenant_id`, every argument redacted before pino formats it. No `hostname`/`pid`:
 * the container already says where a line came from.
 */
export function createLogger(options: LoggerOptions): Logger {
  return withRedactedChildren(
    pino(
      {
        level: options.level ?? 'info',
        base: { service: options.service },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        mixin: correlationFields,
        // Errors are already plain data from redactValue; pino's serializer would rename their type.
        serializers: { err: (err: unknown) => err },
        hooks: {
          logMethod(args, method) {
            const clean = args.map((arg) => redactValue(arg)) as Parameters<typeof method>;
            // A top-level Error became plain data: keep it under `err`, where pino would have put it.
            if (args[0] instanceof Error) clean[0] = { err: clean[0] } as never;
            method.apply(this, clean);
          },
        },
      },
      options.destination ?? pino.destination({ fd: 1, sync: true }),
    ),
  );
}

type ChildFn = (this: Logger, bindings: Bindings, options?: ChildLoggerOptions) => Logger;

/**
 * Fields given to `logger.child({...})` are written on every line of the child, and pino's
 * `logMethod` hook never sees them: redact them when the child is made, at every level. pino makes
 * a child with `Object.create(parent)`, so each logger gets its own wrapper around pino's original
 * `child`, called with that logger as `this` (else a grandchild would lose its parent's fields).
 */
function withRedactedChildren(
  logger: Logger,
  // pino types `child` as generic over custom levels; we use none, so the plain signature fits.
  original = logger.child as unknown as ChildFn,
): Logger {
  const redactedChild = (bindings: Bindings, options?: ChildLoggerOptions): Logger =>
    withRedactedChildren(
      original.call(logger, redactValue(bindings) as Bindings, options),
      original,
    );
  logger.child = redactedChild as unknown as Logger['child'];
  return logger;
}
