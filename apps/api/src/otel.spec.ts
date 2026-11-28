/**
 * RED metrics of the API (T7.3): once metrics are started, the http instrumentation records
 * `http.server.request.duration` with the Express route template and nothing that grows per
 * request. The server runs in a child Node process (`red-metrics.child.cjs`): jest's module
 * registry bypasses the hook the instrumentation patches `http` through.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { HTTP_DURATION_BUCKETS } from 'telemetry';
import { startMetrics, stopMetrics } from './otel';

const run = promisify(execFile);
const CHILD = path.join(__dirname, 'common/otel/red-metrics.child.cjs');

interface Point {
  attributes: Record<string, unknown>;
  count: number;
  boundaries: number[];
}

/** Requests `paths` against an instrumented Express app; returns the recorded points. */
async function serve(paths: string[]): Promise<Point[]> {
  const { stdout } = await run(process.execPath, [CHILD, ...paths], { timeout: 30_000 });
  return JSON.parse(stdout) as Point[];
}

describe('API RED metrics', () => {
  it('counts requests per route template, method and status, never the raw path', async () => {
    const points = await serve([
      '/things/a1?q=secret',
      '/things/b2',
      '/things/c3',
      '/things/missing',
    ]);

    expect(points.map((p) => [p.attributes, p.count])).toEqual(
      expect.arrayContaining([
        [
          {
            'http.request.method': 'GET',
            'http.route': '/things/:id',
            'http.response.status_code': 200,
          },
          3,
        ],
        [
          {
            'http.request.method': 'GET',
            'http.route': '/things/:id',
            'http.response.status_code': 404,
          },
          1,
        ],
      ]),
    );
    expect(points[0]?.boundaries).toEqual(HTTP_DURATION_BUCKETS);
    expect(JSON.stringify(points)).not.toMatch(/a1|b2|secret/);
  });

  it('does not count health probes', async () => {
    expect(await serve(['/health/live', '/health/ready'])).toEqual([]);
  });
});

describe('startMetrics', () => {
  afterEach(() => stopMetrics());

  it('stays off without an OTLP endpoint, like tracing', () => {
    expect(startMetrics('invoice-api', {})).toBe(false);
  });

  it('starts with an endpoint', () => {
    expect(startMetrics('invoice-api', { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' })).toBe(
      true,
    );
  });
});
