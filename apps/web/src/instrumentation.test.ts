import { afterEach, describe, expect, it, vi } from 'vitest';

const startTracing = vi.fn();
vi.mock('./otel.node', () => ({ startTracing }));

const { register } = await import('./instrumentation');

describe('register (Next.js instrumentation hook)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    startTracing.mockClear();
  });

  it('starts no SDK without an OTLP endpoint (tests, CI, plain dev)', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    await register();
    expect(startTracing).not.toHaveBeenCalled();
  });

  it('starts no SDK on the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector.test');
    await register();
    expect(startTracing).not.toHaveBeenCalled();
  });

  it('starts tracing as invoice-web in Node.js with an endpoint', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector.test');
    await register();
    expect(startTracing).toHaveBeenCalledWith('invoice-web');
  });
});
