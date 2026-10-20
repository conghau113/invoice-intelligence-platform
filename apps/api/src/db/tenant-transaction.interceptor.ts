import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../modules/auth/http/authenticated-request';
import { SKIP_TENANT_TRANSACTION } from './skip-tenant-transaction.decorator';
import { TenantDbService } from './tenant-db.service';

/**
 * Runs the whole handler inside one tenant transaction. Interceptors run after guards, so
 * `req.user` is set for authenticated routes; @Public() routes have none and run without a
 * transaction (and `TenantDbService.current()` throws there), and neither do routes marked
 * @SkipTenantTransaction(). A thrown error rolls back.
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (user === undefined) return next.handle();
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(SKIP_TENANT_TRANSACTION, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) === true
    ) {
      return next.handle();
    }
    return from(
      this.tenantDb.run(user.tenantId, () =>
        lastValueFrom(next.handle(), { defaultValue: undefined }),
      ),
    );
  }
}
