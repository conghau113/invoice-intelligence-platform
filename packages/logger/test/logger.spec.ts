import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { Writable } from 'node:stream';
import { createLogger, runWithLogContext } from '../src';

/** Collects the JSON lines a logger writes. */
function capture(): { lines: () => Record<string, unknown>[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const lines = () =>
    chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { lines, stream };
}

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('createLogger', () => {
  const manager = new AsyncLocalStorageContextManager();
  const provider = new TracerProvider();
  beforeAll(() => {
    context.setGlobalContextManager(manager.enable());
  });
  afterAll(async () => {
    context.disable();
    await provider.shutdown();
  });

  it('writes one JSON line with service, level and time, without host or pid', () => {
    const out = capture();
    createLogger({ service: 'invoice-test', destination: out.stream }).info('hello');
    const [line] = out.lines();
    expect(line).toMatchObject({ service: 'invoice-test', level: 'info', msg: 'hello' });
    expect(typeof line?.time).toBe('string');
    expect(line).not.toHaveProperty('hostname');
    expect(line).not.toHaveProperty('pid');
    expect(line).not.toHaveProperty('trace_id'); // no active span, no tenant
    expect(line).not.toHaveProperty('tenant_id');
  });

  it('carries the trace and span id of the active span, so the line leads to its trace', () => {
    const out = capture();
    const log = createLogger({ service: 'invoice-test', destination: out.stream });
    const span = provider.getTracer('t').startSpan('work');
    context.with(trace.setSpan(context.active(), span), () => log.warn('inside'));
    span.end();
    const [line] = out.lines();
    expect(line?.trace_id).toBe(span.spanContext().traceId);
    expect(line?.span_id).toBe(span.spanContext().spanId);
  });

  it('carries the tenant of the log context, also across await', async () => {
    const out = capture();
    const log = createLogger({ service: 'invoice-test', destination: out.stream });
    await runWithLogContext({ tenantId: TENANT }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      log.info('in tenant');
    });
    log.info('outside');
    const [inside, outside] = out.lines();
    expect(inside?.tenant_id).toBe(TENANT);
    expect(outside).not.toHaveProperty('tenant_id');
  });

  it('redacts the message, format arguments, fields and errors', () => {
    const out = capture();
    const log = createLogger({ service: 'invoice-test', destination: out.stream });
    log.info('buyer %s, mail %s', 'Nguyễn Văn Jane SAMPLE', 'jane@example.com');
    log.warn({ seller: { taxCode: '6904000855' }, note: 'MST 6904000855' }, 'Công ty TNHH SAMPLE');
    log.error(new Error('insert failed for jane@example.com'));
    const text = out
      .lines()
      .map((l) => JSON.stringify(l))
      .join('\n');
    for (const secret of ['Nguyễn', 'jane@example.com', '6904000855', 'Công ty']) {
      expect(text).not.toContain(secret);
    }
    const [first, second, third] = out.lines();
    expect(first?.msg).toBe('buyer [NAME], mail [EMAIL]');
    expect(second).toMatchObject({ seller: '[REDACTED]', note: 'MST [TAX_CODE]', msg: '[NAME]' });
    expect(third).toMatchObject({ err: { type: 'Error', message: 'insert failed for [EMAIL]' } });
  });

  it('redacts fields bound with child()', () => {
    const out = capture();
    const log = createLogger({ service: 'invoice-test', destination: out.stream });
    log.child({ buyerName: 'X', note: 'jane@example.com', job: 'j-1' }).info('bound');
    log.child({ job: 'j-1' }).child({ seller: 'Y' }).info('grandchild');
    expect(out.lines()[0]).toMatchObject({
      buyerName: '[REDACTED]',
      note: '[EMAIL]',
      job: 'j-1',
      service: 'invoice-test',
    });
    expect(out.lines()[1]).toMatchObject({ job: 'j-1', seller: '[REDACTED]' });
  });

  it('honours the level', () => {
    const out = capture();
    const log = createLogger({ service: 'invoice-test', level: 'warn', destination: out.stream });
    log.info('dropped');
    log.warn('kept');
    expect(out.lines().map((l) => l.msg)).toEqual(['kept']);
  });
});
