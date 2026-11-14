import type { ApiErrorCode } from 'contracts';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/http/authenticated-request';
import { IS_PUBLIC } from '../../auth/http/public.decorator';
import {
  RATE_LIMITER,
  RateLimiterUnavailableError,
  type RateLimiterPort,
  type TakeResult,
} from '../application/rate-limiter.port';
import { bucketKeys } from '../domain/bucket-keys';
import {
  POLICIES,
  defaultClassFor,
  type RateLimitClass,
  type RateLimitPolicy,
} from '../domain/policies';
import { RATE_LIMIT_CLASS } from './rate-limit.decorator';

/** At most one warning a minute while Redis is down, not one per request. */
const WARN_EVERY_MS = 60_000;

const seconds = (ms: number): number => Math.ceil(ms / 1000);

/**
 * `RateLimit-Policy` and `RateLimit` as in draft-ietf-httpapi-ratelimit-headers-11 (May 2026): one
 * item per bucket. `q` is the capacity and `w` the seconds it takes to refill it; `r` is the whole
 * tokens left and `t` the seconds until the bucket is full again.
 */
function setRateLimitHeaders(
  res: Response,
  cls: RateLimitClass,
  policy: RateLimitPolicy,
  result: TakeResult,
): void {
  const { user, tenant } = policy;
  res.setHeader(
    'RateLimit-Policy',
    `"${cls}-user";q=${user.capacity};w=${user.windowSeconds}, ` +
      `"${cls}-tenant";q=${tenant.capacity};w=${tenant.windowSeconds}`,
  );
  res.setHeader(
    'RateLimit',
    `"${cls}-user";r=${result.user.remaining};t=${seconds(result.user.fullInMs)}, ` +
      `"${cls}-tenant";r=${result.tenant.remaining};t=${seconds(result.tenant.fullInMs)}`,
  );
}

/**
 * Token buckets per (tenant, user, route class) and per (tenant, route class), ADR 0012.
 *
 * Registered as a global guard AFTER JwtAuthGuard and PermissionsGuard (AuthModule), so only a
 * caller who is who they claim and may use the route spends a token: an anonymous or forbidden
 * request is refused before it can drain someone's bucket. An upload is refused before its body is
 * read (multer runs in an interceptor, after guards); a JSON body is parsed before any guard.
 * Public routes (health) are not limited: there is no user to count them against.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiterPort,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const http = ctx.switchToHttp();
    const req = http.getRequest<AuthenticatedRequest>();
    // PermissionsGuard already refused a request without a user; kept so nothing is keyed on undefined.
    if (req.user === undefined) return true;

    const cls =
      this.reflector.getAllAndOverride<RateLimitClass | undefined>(RATE_LIMIT_CLASS, targets) ??
      defaultClassFor(req.method);
    const policy = POLICIES[cls];

    let result: TakeResult;
    try {
      result = await this.limiter.take({
        ...bucketKeys(req.user.tenantId, req.user.userId, cls),
        user: policy.user,
        tenant: policy.tenant,
      });
    } catch (err) {
      if (!(err instanceof RateLimiterUnavailableError)) throw err;
      this.warnLimiterDown(cls, policy);
      if (policy.whenLimiterDown === 'open') return true;
      throw new ServiceUnavailableException({
        message: 'Rate limiter unavailable',
        code: 'RATE_LIMIT_UNAVAILABLE' satisfies ApiErrorCode,
      });
    }

    const res = http.getResponse<Response>();
    setRateLimitHeaders(res, cls, policy, result);
    if (result.allowed) return true;

    // At least one second: `Retry-After: 0` would invite an immediate retry that fails again.
    res.setHeader('Retry-After', String(Math.max(1, seconds(result.retryAfterMs))));
    throw new HttpException(
      { message: 'Too many requests', code: 'RATE_LIMITED' satisfies ApiErrorCode },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private warnLimiterDown(cls: RateLimitClass, policy: RateLimitPolicy): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = now;
    const action = policy.whenLimiterDown === 'open' ? 'letting through' : 'refusing';
    this.logger.warn(`Rate limiter unavailable: ${action} ${cls} requests`);
  }
}
