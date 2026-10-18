import { createParamDecorator, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '../domain/auth-user';
import type { AuthenticatedRequest } from './authenticated-request';

function userOf(ctx: ExecutionContext): AuthUser {
  const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
  if (!user) throw new UnauthorizedException(); // only on a @Public route that asks for a user
  return user;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => userOf(ctx));

export interface TenantContext {
  tenantId: string;
  tenantAlias: string;
}

/** Tenant of the caller, taken from the verified token only; any tenant header is ignored. */
export const CurrentTenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): TenantContext => {
    const { tenantId, tenantAlias } = userOf(ctx);
    return { tenantId, tenantAlias };
  },
);
