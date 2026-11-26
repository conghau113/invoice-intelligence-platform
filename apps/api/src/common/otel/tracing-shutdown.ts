import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { stopTracing } from '../../otel';

/**
 * Flushes the spans still waiting in the batch when Nest shuts down (SIGTERM via
 * enableShutdownHooks). Without it the last few seconds of spans before a restart are lost. A
 * no-op when tracing is off.
 */
@Injectable()
export class TracingShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await stopTracing();
  }
}
