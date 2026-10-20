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

  it('boots with valid env and serves problem+json errors via the real wiring', async () => {
    process.env.NODE_ENV = 'test';
    process.env.OIDC_ISSUER_URL = 'http://localhost:8080/realms/invoice';
    process.env.DATABASE_URL = 'postgres://invoice_app:pw@localhost:5433/invoice';
    process.env.DATA_DIR = '/var/lib/invoice-data';
    const mod = await createBuilder().compile();
    const app: INestApplication = mod.createNestApplication();
    await app.init();
    const res = await request(app.getHttpServer()).get('/nope?q=Nguyen').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(JSON.stringify(res.body)).not.toContain('Nguyen');
    await app.close();
  });
});
