import {
  BadRequestException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { IDEMPOTENCY_KEY_REQUIRED, parseIdempotencyKey } from '../domain/idempotency';

/**
 * Refuses a create request without a usable Idempotency-Key. It is a guard, so it runs before the
 * multer interceptor: a request that will be refused never gets its body written to disk.
 */
@Injectable()
export class IdempotencyKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (parseIdempotencyKey(req.header('idempotency-key')) === null) {
      throw new BadRequestException({
        message: 'A valid Idempotency-Key header is required',
        code: IDEMPOTENCY_KEY_REQUIRED,
      });
    }
    return true;
  }
}
