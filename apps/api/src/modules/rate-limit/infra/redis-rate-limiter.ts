import type { OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  RateLimiterUnavailableError,
  type RateLimiterPort,
  type TakeRequest,
  type TakeResult,
} from '../application/rate-limiter.port';
import { TOKEN_BUCKET_LUA } from './token-bucket.script';

/** The command `defineCommand` adds to the connection: EVALSHA, falling back to EVAL once. */
type WithTakeTokens = Redis & {
  takeTokens(
    userKey: string,
    tenantKey: string,
    userCapacity: number,
    userWindowMs: number,
    tenantCapacity: number,
    tenantWindowMs: number,
  ): Promise<unknown>;
};

type Reply = [number, number, number, number, number, number];

const isReply = (value: unknown): value is Reply =>
  Array.isArray(value) &&
  value.length === 6 &&
  value.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0);

/**
 * Token buckets in Redis (ADR 0012). Use a connection that fails at once when Redis is down
 * (`producerConnection`): a request must not wait for Redis to come back.
 */
export class RedisRateLimiter implements RateLimiterPort, OnApplicationShutdown {
  private readonly redis: WithTakeTokens;

  constructor(redis: Redis) {
    redis.defineCommand('takeTokens', { numberOfKeys: 2, lua: TOKEN_BUCKET_LUA });
    this.redis = redis as WithTakeTokens;
  }

  async take({ userKey, tenantKey, user, tenant }: TakeRequest): Promise<TakeResult> {
    let reply: unknown;
    try {
      reply = await this.redis.takeTokens(
        userKey,
        tenantKey,
        user.capacity,
        user.windowSeconds * 1000,
        tenant.capacity,
        tenant.windowSeconds * 1000,
      );
    } catch {
      // The ioredis message names the host; the caller only needs to know there is no answer.
      throw new RateLimiterUnavailableError();
    }
    if (!isReply(reply)) throw new RateLimiterUnavailableError();
    const [allowed, retryAfterMs, userRemaining, userFullIn, tenantRemaining, tenantFullIn] = reply;
    return {
      allowed: allowed === 1,
      retryAfterMs,
      user: { remaining: userRemaining, fullInMs: userFullIn },
      tenant: { remaining: tenantRemaining, fullInMs: tenantFullIn },
    };
  }

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}
