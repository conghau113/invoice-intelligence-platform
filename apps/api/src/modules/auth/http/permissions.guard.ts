import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { permissionsOf, type Permission } from '../permissions';
import type { AuthenticatedRequest } from './authenticated-request';
import { IS_PUBLIC } from './public.decorator';
import { ANY_AUTHENTICATED, REQUIRED_PERMISSIONS } from './require-permission.decorator';

/** Runs after JwtAuthGuard (registered after it in AuthModule), so req.user is already set. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSIONS,
      targets,
    );
    // A declared permission always wins over a broader @AnyAuthenticated on the class.
    if (required === undefined) {
      if (this.reflector.getAllAndOverride<boolean>(ANY_AUTHENTICATED, targets)) {
        if (user === undefined) throw new UnauthorizedException();
        return true;
      }
      // A programming error (route forgot to declare its policy), not the caller's fault.
      throw new ForbiddenException({
        message: 'Route has no declared permission',
        code: 'FORBIDDEN_UNDECLARED',
      });
    }

    const held = new Set(permissionsOf(user?.roles ?? []));
    const missing = required.find((p) => !held.has(p));
    if (missing !== undefined) {
      throw new ForbiddenException({
        message: `Missing permission: ${missing}`,
        code: 'FORBIDDEN_PERMISSION',
      });
    }
    return true;
  }
}
