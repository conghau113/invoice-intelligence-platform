import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PG_POOL } from '../../../db/db.module';
import { EXTRACTION_QUEUE_PORT } from '../../queue/application/extraction-queue.port';
import { FakeExtractionQueue } from '../../queue/testing/fake-extraction-queue';
import { HealthModule } from '../health.module';

let query: jest.Mock;
const queue = new FakeExtractionQueue();

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: () => ({ query: (...a: unknown[]) => query(...a) }) },
  ],
  exports: [PG_POOL],
})
class FakePoolModule {}

describe('HealthController (http)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [FakePoolModule, HealthModule],
    })
      .overrideProvider(EXTRACTION_QUEUE_PORT)
      .useValue(queue)
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  it('GET /health -> 200 and never touches the database', async () => {
    query = jest.fn();
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('GET /health/ready -> 200 when the database answers', async () => {
    query = jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok' } });
  });

  it('GET /health/ready -> 503 when Redis is down; /health stays 200 (liveness must not depend on it)', async () => {
    query = jest.fn().mockResolvedValue({ rows: [] });
    queue.down = true;
    try {
      await request(app.getHttpServer()).get('/health/ready').expect(503);
      await request(app.getHttpServer()).get('/health').expect(200);
    } finally {
      queue.down = false;
    }
  });

  it('GET /health/ready -> 503 without detail when the database fails', async () => {
    query = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED db.internal:5432'));
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(JSON.stringify(res.body)).not.toContain('db.internal');
  });
});
