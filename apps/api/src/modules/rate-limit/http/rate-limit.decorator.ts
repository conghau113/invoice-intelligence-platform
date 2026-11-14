import { SetMetadata } from '@nestjs/common';
import type { RateLimitClass } from '../domain/policies';

export const RATE_LIMIT_CLASS = 'rateLimitClass';

/**
 * Puts a route in a stricter (or explicit) rate limit class. Without it a GET is `read` and any
 * other method is `write` (see policies.ts).
 */
export const RateLimit = (cls: RateLimitClass): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_CLASS, cls);
