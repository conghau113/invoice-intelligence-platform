import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from '../domain/auth-user';
import { permissionsOf, type Permission } from '../permissions';
import { CurrentUser } from './current-user.decorator';
import { AnyAuthenticated } from './require-permission.decorator';

@Controller('auth')
export class AuthController {
  /** Who does the API think I am? `permissions` lets the UI hide actions (the API still enforces). */
  @AnyAuthenticated()
  @Get('me')
  me(
    @CurrentUser() user: AuthUser,
  ): Pick<AuthUser, 'userId' | 'tenantId' | 'roles'> & { permissions: Permission[] } {
    return {
      userId: user.userId,
      tenantId: user.tenantId,
      roles: user.roles,
      permissions: permissionsOf(user.roles),
    };
  }
}
