import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema';
import type { AuthUser } from '../domain/auth-user';
import { effectivePermissions, type Permission } from '../permissions';
import { CurrentUser } from './current-user.decorator';
import { AnyAuthenticated } from './require-permission.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  /** Who does the API think I am? `tenants` feeds the tenant switcher; `permissions` lets the UI hide actions (the API still enforces). */
  @AnyAuthenticated()
  @Get('me')
  me(@CurrentUser() user: AuthUser): Pick<AuthUser, 'userId' | 'tenantId' | 'roles'> & {
    tenants: readonly string[];
    permissions: Permission[];
  } {
    return {
      userId: user.userId,
      tenantId: user.tenantId,
      roles: user.roles,
      tenants: user.memberOf,
      // On the read-only demo only read permissions, so the UI hides upload/approve/settings.
      // Hiding is usability; DemoReadOnlyGuard is what refuses the writes.
      permissions: effectivePermissions(
        user.roles,
        this.config.get('DEMO_READ_ONLY', { infer: true }),
      ),
    };
  }
}
