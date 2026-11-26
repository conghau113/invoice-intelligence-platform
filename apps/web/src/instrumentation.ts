/**
 * Next.js calls `register()` once per server start (T7.1, ADR 0015). Tracing runs only in the
 * Node.js runtime (the SDK does not work on the edge) and only when an OTLP endpoint is set, so
 * tests, CI and a plain dev server start no SDK.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const { startTracing } = await import('./otel.node');
    startTracing('invoice-web');
  }
}
