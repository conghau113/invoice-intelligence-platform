import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../modules/auth/http/authenticated-request';
import { TenantDbService } from './tenant-db.service';

/**
 * Runs the whole handler inside one tenant transaction. Interceptors run after guards, so
 * `req.user` is set for authenticated routes; @Public() routes have none and run without a
 * transaction (and `TenantDbService.current()` throws there). A thrown error rolls back.
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(private readonly tenantDb: TenantDbService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (user === undefined) return next.handle();
    return from(
      this.tenantDb.run(user.tenantId, () =>
        lastValueFrom(next.handle(), { defaultValue: undefined }),
      ),
    );
  }
}
