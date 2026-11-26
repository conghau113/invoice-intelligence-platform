import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter, TracerProvider } from '@opentelemetry/sdk-trace';
import { registerTracerProvider, withoutQuery } from '../src';

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

const exported = (s: ReadableSpan | undefined) =>
  JSON.stringify([s?.name, s?.attributes, s?.events, s?.status]);

describe('telemetry', () => {
  const exporter = new CollectingExporter();
  let provider: TracerProvider;

  beforeAll(() => {
    provider = registerTracerProvider('invoice-test', 'test', exporter);
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    propagation.disable();
    context.disable();
  });
  beforeEach(() => {
    exporter.spans.length = 0;
  });

  const record = async (
    fill: (span: ReturnType<ReturnType<typeof trace.getTracer>['startSpan']>) => void,
  ) => {
    const span = trace.getTracer('test').startSpan('work');
    fill(span);
    span.end();
    await provider.forceFlush();
    return exporter.spans.find((s) => s.name === 'work');
  };

  it('names the service and the environment on every span', async () => {
    const span = await record(() => undefined);
    expect(span?.resource.attributes['service.name']).toBe('invoice-test');
    expect(span?.resource.attributes['deployment.environment.name']).toBe('test');
  });

  it('cuts the query string out of URL attributes', async () => {
    const span = await record((s) =>
      s.setAttributes({
        'url.full': 'http://api/documents?q=SAMPLE%20Company#top',
        'url.query': 'q=SAMPLE%20Company',
      }),
    );
    expect(span?.attributes['url.full']).toBe('http://api/documents');
    expect(span?.attributes['url.query']).toBe('REDACTED');
    expect(exported(span)).not.toContain('SAMPLE');
  });

  it('keeps only the type of an error that an instrumentation recorded, never its message', async () => {
    // What pg's instrumentation does with a rejected query: exception event + status message.
    const leak = 'invalid input syntax for type uuid: "SAMPLE Company"';
    const span = await record((s) => {
      s.recordException(Object.assign(new Error(leak), { name: 'DatabaseError' }));
      s.addEvent('kept', { step: 1 });
      s.setStatus({ code: SpanStatusCode.ERROR, message: leak });
    });
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span?.events.map((e) => e.name)).toEqual(['kept']);
    expect(span?.attributes['error.type']).toBe('DatabaseError');
    expect(exported(span)).not.toContain('SAMPLE');
  });

  it('leaves an error type that is already set', async () => {
    const span = await record((s) => {
      s.setAttribute('error.type', 'EXTRACTION_RETRY');
      s.recordException(new TypeError('boom'));
    });
    expect(span?.attributes['error.type']).toBe('EXTRACTION_RETRY');
  });

  it.each([
    ['http://a/b?x=1', 'http://a/b'],
    ['/path#frag', '/path'],
    ['/plain', '/plain'],
  ])('withoutQuery(%s) is %s', (url, want) => {
    expect(withoutQuery(url)).toBe(want);
  });
});
