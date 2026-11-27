import { ConfigService } from '@nestjs/config';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Env } from '../../config/env.schema';
import { HttpAiExtractor } from '../../modules/extraction/infra/http-ai-extractor';
import { ExtractionJobError } from '../../modules/queue/domain/extraction-job';
import { flushTracing, startTracing, stopTracing } from '../../otel';
import { captureLines } from '../logging/capture.testing';
import { withJobLogContext } from '../logging/job-log-context';
import { NestPinoLogger } from '../logging/nest-logger';
import { activeTraceparent, runInConsumerSpan } from './trace-context';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const UPLOAD_SPAN_ID = 'b7ad6b7169203331';
const JOB_TRACEPARENT = `00-${TRACE_ID}-${UPLOAD_SPAN_ID}-01`;
const W3C = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

/** Keeps every exported span in memory, like the OTLP exporter would send them. */
class CollectingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], done: (r: { code: number }) => void): void {
    this.spans.push(...spans);
    done({ code: 0 });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe('trace context (tracing off)', () => {
  it('has no traceparent to hand on: the caller keeps its own', () => {
    expect(activeTraceparent()).toBeUndefined();
  });
});

describe('trace context (tracing on, real HTTP against a local stub)', () => {
  const exporter = new CollectingExporter();
  let server: Server;
  /** Raw header pairs of the last request: a duplicated header shows up twice here. */
  let rawHeaders: string[] = [];
  let lastUrl: string | undefined;

  const stubUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const traceparentsSeen = () =>
    rawHeaders.filter((_, i) => i % 2 === 0 && rawHeaders[i]?.toLowerCase() === 'traceparent')
      .length;
  const headerValue = (name: string) => {
    const i = rawHeaders.findIndex((h, k) => k % 2 === 0 && h.toLowerCase() === name);
    return i === -1 ? undefined : rawHeaders[i + 1];
  };
  const extractor = () =>
    new HttpAiExtractor({
      get: (k: keyof Env) =>
        ({ AI_SERVICE_URL: stubUrl(), AI_SERVICE_TOKEN: 'unit-test-token-0123456789' })[
          k as string
        ],
    } as unknown as ConfigService<Env, true>);
  const spanNamed = (name: string) => exporter.spans.find((s) => s.name === name);

  beforeAll(async () => {
    expect(startTracing('invoice-worker', {}, exporter)).toBe(true);
    server = createServer((req: IncomingMessage, res) => {
      rawHeaders = req.rawHeaders;
      lastUrl = req.url;
      if (req.url === '/drop') {
        req.socket.destroy(); // the connection dies before any answer
        return;
      }
      req.resume();
      req.on('end', () => {
        // An answer the extractor refuses is fine: only the request matters here.
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'XML_MALFORMED' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    await stopTracing();
    // fetch keeps its connection to the stub alive; close() alone would wait for it.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    exporter.spans.length = 0;
    rawHeaders = [];
  });

  it('continues the upload trace in the worker and sends exactly one traceparent to the AI service', async () => {
    await runInConsumerSpan(
      'extraction process',
      JOB_TRACEPARENT,
      { 'messaging.message.id': 'doc-1' },
      () =>
        extractor()
          // The job's own traceparent too: with tracing on it must not become a second header.
          .extract({
            bytes: Buffer.from('<xml>SAMPLE</xml>'),
            sourceType: 'xml',
            traceparent: JOB_TRACEPARENT,
          })
          .catch(() => undefined),
    );
    await flushTracing();

    const job = spanNamed('extraction process');
    expect(job?.kind).toBe(SpanKind.CONSUMER);
    expect(job?.spanContext().traceId).toBe(TRACE_ID);
    expect(job?.parentSpanContext?.spanId).toBe(UPLOAD_SPAN_ID);

    // The AI service sees the same trace, with the worker's outgoing call as parent.
    expect(traceparentsSeen()).toBe(1);
    const [, traceId, parentId] = W3C.exec(headerValue('traceparent') ?? '') ?? [];
    expect(traceId).toBe(TRACE_ID);
    expect(parentId).not.toBe(UPLOAD_SPAN_ID); // the worker's call, not the job's raw value
    const call = exporter.spans.find((s) => s.kind === SpanKind.CLIENT);
    expect(call?.spanContext().spanId).toBe(parentId);
    expect(call?.parentSpanContext?.spanId).toBe(job?.spanContext().spanId);
  });

  it('a log line written in the job carries the trace, span and tenant of the job (T7.2)', async () => {
    const out = captureLines();
    const log = new NestPinoLogger({ service: 'invoice-worker', destination: out.stream });
    const tenantId = '00000000-0000-4000-8000-0000000000a1';
    await withJobLogContext({ tenantId }, () =>
      runInConsumerSpan('extraction process', JOB_TRACEPARENT, {}, () => {
        log.warn('job doc-1 failed (EXTRACTION_RETRY)', 'ExtractionWorker');
        return Promise.resolve();
      }),
    );
    await flushTracing();
    const job = spanNamed('extraction process');
    expect(out.lines()).toEqual([
      expect.objectContaining({
        service: 'invoice-worker',
        trace_id: TRACE_ID,
        span_id: job?.spanContext().spanId,
        tenant_id: tenantId,
      }),
    ]);
  });

  it('starts a new trace when the job has no usable traceparent', async () => {
    await runInConsumerSpan('extraction process', 'junk', {}, () => Promise.resolve());
    await flushTracing();
    const job = spanNamed('extraction process');
    expect(job?.parentSpanContext).toBeUndefined();
    expect(job?.spanContext().traceId).not.toBe(TRACE_ID);
  });

  it('records a failed job by its code only, never the message', async () => {
    const err = new ExtractionJobError('EXTRACTION_RETRY', true);
    err.message = 'text that may contain document content';
    await expect(
      runInConsumerSpan('extraction process', JOB_TRACEPARENT, {}, () => Promise.reject(err)),
    ).rejects.toBe(err);
    await flushTracing();
    const job = spanNamed('extraction process');
    expect(job?.status.code).toBe(SpanStatusCode.ERROR);
    expect(job?.attributes['error.type']).toBe('EXTRACTION_RETRY');
    expect(JSON.stringify([job?.attributes, job?.events, job?.status])).not.toContain(
      'document content',
    );
  });

  it('hands on the traceparent of the span running now', () => {
    trace.getTracer('test').startActiveSpan('upload', (span) => {
      const { traceId, spanId } = span.spanContext();
      expect(activeTraceparent()).toBe(`00-${traceId}-${spanId}-01`);
      span.end();
    });
  });

  it('keeps only the type of an error that an instrumentation recorded, never its message', async () => {
    // What pg's instrumentation does with a rejected query: exception event + status message.
    const leak = 'invalid input syntax for type uuid: "SAMPLE Company"';
    trace.getTracer('pg-like').startActiveSpan('pg.query:SELECT', (span) => {
      span.recordException(Object.assign(new Error(leak), { name: 'DatabaseError' }));
      span.setStatus({ code: SpanStatusCode.ERROR, message: leak });
      span.end();
    });
    await flushTracing();
    const query = spanNamed('pg.query:SELECT');
    expect(query?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(query?.events).toEqual([]);
    expect(query?.attributes['error.type']).toBe('DatabaseError');
    expect(
      JSON.stringify([query?.name, query?.attributes, query?.events, query?.status]),
    ).not.toContain('SAMPLE');
  });

  it('a fetch that fails on the wire is an error span without the error text', async () => {
    await fetch(`${stubUrl()}/drop`).catch(() => undefined);
    await flushTracing();
    const call = exporter.spans.find((s) => s.kind === SpanKind.CLIENT);
    expect(call?.status.code).toBe(SpanStatusCode.ERROR);
    expect(call?.status.message).toBeUndefined();
    expect(call?.events.filter((e) => e.name === 'exception')).toEqual([]);
    expect(call?.attributes['error.type']).toEqual(expect.any(String));
  });

  it('cuts the query string out of URL attributes', async () => {
    await fetch(`${stubUrl()}/search?q=SAMPLE%20Company&tenant=x`).then((r) => r.text());
    await flushTracing();
    expect(lastUrl).toBe('/search?q=SAMPLE%20Company&tenant=x'); // the request itself is unchanged
    const call = exporter.spans.find((s) => s.kind === SpanKind.CLIENT);
    expect(call?.attributes['url.full']).toBe(`${stubUrl()}/search`);
    expect(call?.attributes['url.query']).toBe('REDACTED');
    expect(JSON.stringify(call?.attributes)).not.toContain('SAMPLE');
  });
});
