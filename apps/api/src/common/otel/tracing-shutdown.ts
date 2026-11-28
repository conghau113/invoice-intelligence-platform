import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { stopMetrics, stopTracing } from '../../otel';

/**
 * Flushes the spans still waiting in the batch when Nest shuts down (SIGTERM via
 * enableShutdownHooks), and the last metric values (T7.3). Without it the last few seconds of spans
 * before a restart are lost. A no-op when tracing and metrics are off.
 */
@Injectable()
export class TracingShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([stopTracing(), stopMetrics()]);
  }
}
