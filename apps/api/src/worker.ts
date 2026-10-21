import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './modules/queue/worker.module';

/** Entry of the queue consumer. A separate process from main.ts (ADR 0008): a slow job cannot stall HTTP. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // On SIGTERM the worker finishes its running jobs before the process exits.
  app.enableShutdownHooks();
}

bootstrap().catch((e: unknown) => {
  // Nest logs dependency and env errors itself; an error thrown while the worker starts (e.g. a
  // bad Redis URL) is not logged, so say what kind it was. The message is left out: it can hold a host.
  new Logger('Worker').error(`Failed to start (${e instanceof Error ? e.name : 'error'})`);
  process.exit(1);
});
