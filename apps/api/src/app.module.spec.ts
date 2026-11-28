/* eslint-disable @typescript-eslint/no-require-imports --
   ConfigModule.forRoot({ validate }) reads process.env when app.module is first imported, so each
   test must set the env first and load the modules afterwards (require, not a top-level import). */
import type { INestApplication } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';

// Loads AppModule and @nestjs/testing from the same fresh registry so they share one @nestjs/core.
function createBuilder(): TestingModuleBuilder {
  let builder!: TestingModuleBuilder;
  jest.isolateModules(() => {
    const { Test } = require('@nestjs/testing');
    const { AppModule } = require('./app.module');
    builder = Test.createTestingModule({ imports: [AppModule] });
  });
  return builder;
}

describe('AppModule', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('refuses to boot when a required env variable is missing (fail-fast)', async () => {
    delete process.env.NODE_ENV;
    await expect(createBuilder().compile()).rejects.toThrow(/NODE_ENV/);
  });

  const setValidEnv = () => {
    process.env.NODE_ENV = 'test';
    process.env.OIDC_ISSUER_URL = 'http://localhost:8080/realms/invoice';
    process.env.DATABASE_URL = 'postgres://invoice_app:pw@localhost:5433/invoice';
    process.env.DATA_DIR = '/var/lib/invoice-data';
    process.env.REDIS_URL = 'redis://localhost:6380';
    process.env.AI_SERVICE_URL = 'http://localhost:8000';
    process.env.AI_SERVICE_TOKEN = 'unit-test-token-0123456789';
  };

  it('boots with valid env and serves problem+json errors via the real wiring', async () => {
    setValidEnv();
    const mod = await createBuilder().compile();
    const app: INestApplication = mod.createNestApplication();
    await app.init();
    const res = await request(app.getHttpServer()).get('/nope?q=Nguyen').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(JSON.stringify(res.body)).not.toContain('Nguyen');
    await app.close();
  });

  it('registers the queue and cache gauges once metrics are on (T7.3)', async () => {
    setValidEnv();
    const api = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
    const sdk =
      require('@opentelemetry/sdk-metrics') as typeof import('@opentelemetry/sdk-metrics');
    const exporter = new sdk.InMemoryMetricExporter(sdk.AggregationTemporality.CUMULATIVE);
    const provider = new sdk.MeterProvider({
      readers: [
        new sdk.PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 }),
      ],
    });
    // What startMetrics does before Nest loads (otel-api.ts).
    api.metrics.setGlobalMeterProvider(provider);
    const app: INestApplication = (await createBuilder().compile()).createNestApplication();
    let names: string[];
    try {
      await app.init();
      // Redis may or may not run here: either way `queue.reachable` is observed (1 or 0).
      await provider.forceFlush();
      names = exporter
        .getMetrics()
        .flatMap((r) => r.scopeMetrics)
        .flatMap((sm) => sm.metrics.map((m) => m.descriptor.name));
    } finally {
      // Closed whatever happened: an open app keeps jest from exiting instead of failing the test.
      await app.close();
      await provider.shutdown();
      api.metrics.disable();
    }
    expect(names).toContain('queue.reachable');
  });
});
