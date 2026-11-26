import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { flushTracing, startTracing } from './otel.node';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const BROWSER_SPAN = 'b7ad6b7169203331';

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

describe('web tracing (real fetch against a local stub)', () => {
  const exporter = new CollectingExporter();
  let server: Server;
  let rawHeaders: string[] = [];
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  beforeAll(async () => {
    startTracing('invoice-web', exporter);
    server = createServer((req, res) => {
      rawHeaders = req.rawHeaders;
      if (req.url === '/drop') {
        req.socket.destroy(); // the connection dies before any answer
        return;
      }
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(() => {
    // fetch keeps its connection to the stub alive; close() alone would wait for it.
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    exporter.spans.length = 0;
    rawHeaders = [];
  });

  it("puts exactly one traceparent on the call to the API, from the BFF route's span", async () => {
    // What Next does for an incoming request: continue the caller's trace in a server span.
    const incoming = propagation.extract(ROOT_CONTEXT, {
      traceparent: `00-${TRACE_ID}-${BROWSER_SPAN}-01`,
    });
    const route = trace
      .getTracer('test')
      .startSpan('POST /api/documents/upload', { kind: SpanKind.SERVER }, incoming);
    await context.with(trace.setSpan(incoming, route), () =>
      fetch(`${url()}/documents/upload`, { method: 'POST' }).then((r) => r.text()),
    );
    route.end();
    await flushTracing();

    // Raw pairs: a header sent twice shows up twice here.
    const sent = rawHeaders.filter(
      (_, i) => i % 2 === 1 && rawHeaders[i - 1]?.toLowerCase() === 'traceparent',
    );
    expect(sent).toHaveLength(1);
    const [, traceId, parentId] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(sent[0] ?? '') ?? [];
    expect(traceId).toBe(TRACE_ID);
    const call = exporter.spans.find((s) => s.kind === SpanKind.CLIENT);
    expect(call?.spanContext().spanId).toBe(parentId);
    expect(call?.parentSpanContext?.spanId).toBe(route.spanContext().spanId);
  });

  it('cuts the query string out of URL attributes', async () => {
    await fetch(`${url()}/documents?q=SAMPLE%20Company`).then((r) => r.text());
    await flushTracing();
    const call = exporter.spans.find((s) => s.kind === SpanKind.CLIENT);
    expect(call?.attributes['url.full']).toBe(`${url()}/documents`);
    expect(JSON.stringify(call?.attributes)).not.toContain('SAMPLE');
  });

  it('keeps only the type of an error, never its message or stack', async () => {
    const leak = 'upstream said: SAMPLE Company';
    trace.getTracer('test').startActiveSpan('route', (span) => {
      span.recordException(Object.assign(new Error(leak), { name: 'UpstreamError' }));
      span.setStatus({ code: SpanStatusCode.ERROR, message: leak });
      span.end();
    });
    await fetch(`${url()}/drop`).catch(() => undefined);
    await flushTracing();

    const route = exporter.spans.find((s) => s.name === 'route');
    expect(route?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(route?.events).toEqual([]);
    expect(route?.attributes['error.type']).toBe('UpstreamError');
    const call = exporter.spans.find((s) => s.kind === SpanKind.CLIENT);
    expect(call?.status.code).toBe(SpanStatusCode.ERROR);
    expect(call?.status.message).toBeUndefined();
    expect(call?.events).toEqual([]);
    const exported = exporter.spans.map((s) => [s.attributes, s.events, s.status]);
    expect(JSON.stringify(exported)).not.toContain('SAMPLE');
  });
});
