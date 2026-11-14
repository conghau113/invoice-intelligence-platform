import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { producerConnection } from '../queue/infra/redis-connection';
import { RATE_LIMITER } from './application/rate-limiter.port';
import { RedisRateLimiter } from './infra/redis-rate-limiter';

/**
 * The token bucket store (ADR 0012). The guard itself is registered by AuthModule, right after the
 * permission check, because global guards run in the order they are registered.
 */
@Module({
  providers: [
    {
      provide: RATE_LIMITER,
      inject: [ConfigService],
      // Its own connection, failing at once while Redis is down (no request waits on it).
      useFactory: (config: ConfigService<Env, true>) => {
        const url = config.get('REDIS_URL', { infer: true });
        // ioredis would fall back to localhost:6379 without a URL: refuse instead of guessing.
        if (!url) throw new Error('REDIS_URL is required by the rate limiter');
        return new RedisRateLimiter(producerConnection(url));
      },
    },
  ],
  exports: [RATE_LIMITER],
})
export class RateLimitModule {}
