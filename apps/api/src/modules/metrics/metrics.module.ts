import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import {
  METRICS_SOURCE,
  registerOperationalMetrics,
  type MetricsSource,
} from './application/operational-metrics';
import { RedisMetricsSource } from './infra/redis-metrics-source';

/** Meter name of the API's own instruments (the http instrumentation has its own). */
export const API_METER = 'invoice-api';

/**
 * Queue and cache gauges (T7.3). In AppModule only, not in the worker. Registering on the global
 * meter is a no-op while metrics are off (`startMetrics` not called): no reader, no callback.
 */
@Module({ providers: [{ provide: METRICS_SOURCE, useClass: RedisMetricsSource }] })
export class MetricsModule implements OnModuleInit {
  constructor(@Inject(METRICS_SOURCE) private readonly source: MetricsSource) {}

  onModuleInit(): void {
    registerOperationalMetrics(metrics.getMeter(API_METER), this.source);
  }
}
