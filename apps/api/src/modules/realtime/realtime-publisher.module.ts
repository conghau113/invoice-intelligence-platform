import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { producerConnection } from '../queue/infra/redis-connection';
import { REALTIME_PUBLISHER } from './application/realtime-publisher.port';
import { RedisEmitterPublisher } from './infra/redis-emitter-publisher';

/** A publish must never hold up the request or job that committed the change. */
const PUBLISH_TIMEOUT_MS = 500;

/**
 * The publishing side of realtime, for both processes: the API and the worker (whose status
 * changes are most of the events). No Socket.IO server here; see RealtimeModule for that.
 */
@Module({
  providers: [
    {
      provide: REALTIME_PUBLISHER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const url = config.get('REDIS_URL', { infer: true });
        if (!url) throw new Error('REDIS_URL is required by realtime');
        return new RedisEmitterPublisher(producerConnection(url, PUBLISH_TIMEOUT_MS));
      },
    },
  ],
  exports: [REALTIME_PUBLISHER],
})
export class RealtimePublisherModule {}
