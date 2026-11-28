import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TracingModule } from './tracing.module';

const order: string[] = [];

jest.mock('../../otel', () => ({
  stopTracing: () => {
    order.push('tracing stopped');
    return Promise.resolve();
  },
  stopMetrics: () => {
    order.push('metrics stopped');
    return Promise.resolve();
  },
}));

/** Stands for ExtractionWorker: shutting down waits for the job it is running. */
@Injectable()
class SlowWorker implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
    order.push('last job finished');
  }
}

/** Like WorkerModule: the worker sits in the root module. */
@Module({ imports: [TracingModule], providers: [SlowWorker] })
class WorkerLikeRoot {}

/** Like AppModule: the slow part is a feature module, imported next to TracingModule. */
@Module({ providers: [SlowWorker] })
class FeatureModule {}
@Module({ imports: [FeatureModule, TracingModule] })
class AppLikeRoot {}

describe('TracingModule stops tracing and metrics only after the rest of the app has shut down', () => {
  beforeEach(() => {
    order.length = 0;
  });

  it.each([
    ['provided by the root module', WorkerLikeRoot],
    ['in a feature module at the same depth', AppLikeRoot],
  ])('the slow shutdown is %s', async (_, root) => {
    const app = await NestFactory.createApplicationContext(root, { logger: false });
    await app.close();
    expect(order).toEqual(['last job finished', 'tracing stopped', 'metrics stopped']);
  });
});
