import { Controller, Get, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { applyCorsPolicy } from './cors-policy';

@Controller('probe')
class ProbeController {
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }

  @Post()
  write(): { ok: true } {
    return { ok: true };
  }
}

describe('applyCorsPolicy', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = mod.createNestApplication<NestExpressApplication>({ logger: false });
    applyCorsPolicy(app);
    await app.init();
  });
  afterAll(() => app.close());

  const corsHeaders = (headers: Record<string, string>) =>
    Object.keys(headers).filter((h) => h.startsWith('access-control-'));

  it.each(['https://evil.example', 'http://localhost:3000', 'null'])(
    'gives a page on %s nothing it could read a response with',
    async (origin) => {
      const res = await request(app.getHttpServer()).get('/probe').set('Origin', origin);
      expect(res.status).toBe(200);
      expect(corsHeaders(res.headers)).toEqual([]);
    },
  );

  // The cors middleware steps aside entirely when origin is false, so no route answers OPTIONS.
  it('allows no preflight: 404 and no Access-Control-* header', async () => {
    const res = await request(app.getHttpServer())
      .options('/probe')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization, content-type');
    expect(res.status).toBe(404);
    expect(corsHeaders(res.headers)).toEqual([]);
  });
});
