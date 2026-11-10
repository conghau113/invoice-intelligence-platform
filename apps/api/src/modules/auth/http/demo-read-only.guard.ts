import type { ApiErrorCode } from 'contracts';
import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../../../config/env.schema';

/** Methods that only read. Everything else changes state and is refused on the demo. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The public demo is read-only (ADR 0018): with DEMO_READ_ONLY=true every request that is not a
 * GET/HEAD/OPTIONS gets 403 `DEMO_READ_ONLY`, whoever sends it and whatever its route declares.
 *
 * Registered as the FIRST global guard (AuthModule), so it runs before authentication: an
 * anonymous write gets the same answer, and an upload is refused before its body is read
 * (multer runs in an interceptor, after guards). JSON bodies are still parsed before any guard,
 * within the JSON body limit. The second layer is the read-only DB transaction (TenantDbService).
 */
@Injectable()
export class DemoReadOnlyGuard implements CanActivate {
  private readonly readOnly: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.readOnly = config.get('DEMO_READ_ONLY', { infer: true }) === true;
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.readOnly) return true;
    const method = ctx.switchToHttp().getRequest<Request>().method.toUpperCase();
    if (SAFE_METHODS.has(method)) return true;
    throw new ForbiddenException({
      message: 'The public demo is read-only',
      code: 'DEMO_READ_ONLY' satisfies ApiErrorCode,
    });
  }
}
