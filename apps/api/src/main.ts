import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { applyJsonBodyLimit } from './common/http/json-body-limit';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.disable('x-powered-by');
  applyJsonBodyLimit(app);
  // req.ip then follows X-Forwarded-For only from these peers (audit rows record the caller's address).
  app.set('trust proxy', app.get(ConfigService<Env, true>).get('TRUSTED_PROXIES', { infer: true }));
  // Without this SIGTERM kills the process before onApplicationShutdown can drain the DB pool.
  app.enableShutdownHooks();
  const port = app.get(ConfigService<Env, true>).get('PORT', { infer: true });
  await app.listen(port);
}

bootstrap().catch(() => {
  // Nest already logged the cause (e.g. which env variable is invalid); just fail the process.
  process.exit(1);
});
