/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: the instrumentations patch http and express through require(), so this file must load them that way. */
/**
 * Child process of otel.spec.ts. Jest loads modules through its own registry, which the http
 * instrumentation cannot patch, so the server side runs here in plain Node: metrics and tracing
 * start first (as otel-api.ts does), then Express (what Nest runs on) is loaded and serves a few
 * requests. Prints the recorded `http.server.request.duration` points as JSON on stdout.
 */
const { AggregationTemporality, InMemoryMetricExporter } = require('@opentelemetry/sdk-metrics');
const {
  flushMetrics,
  startMetrics,
  startTracing,
  stopMetrics,
  stopTracing,
} = require('../../otel.ts');

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const discard = { export: (_spans, done) => done({ code: 0 }), shutdown: async () => {} };

async function main() {
  startMetrics('invoice-api', {}, exporter, 3_600_000);
  startTracing('invoice-api', {}, discard);

  const express = require('express');
  const app = express();
  app.get('/things/:id', (req, res) => {
    if (req.params.id === 'missing') res.status(404).end();
    else res.json({ id: req.params.id });
  });
  app.get('/health/live', (_req, res) => res.send('ok'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const path of process.argv.slice(2)) await (await fetch(base + path)).arrayBuffer();

  await flushMetrics();
  const points = exporter
    .getMetrics()
    .flatMap((r) => r.scopeMetrics)
    .flatMap((s) => s.metrics)
    .filter((m) => m.descriptor.name === 'http.server.request.duration')
    .flatMap((m) => m.dataPoints)
    .map((p) => ({
      attributes: p.attributes,
      count: p.value.count,
      boundaries: p.value.buckets.boundaries,
    }));
  process.stdout.write(JSON.stringify(points));

  await new Promise((resolve) => server.close(resolve));
  await stopTracing();
  await stopMetrics();
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack));
  process.exitCode = 1;
});
