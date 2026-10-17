import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from '../domain/auth-user';
import { CurrentUser } from './current-user.decorator';

@Controller('auth')
export class AuthController {
  /** Proof endpoint for T1.2: who does the API think I am? */
  @Get('me')
  me(@CurrentUser() user: AuthUser): Pick<AuthUser, 'userId' | 'tenantId' | 'roles'> {
    return { userId: user.userId, tenantId: user.tenantId, roles: user.roles };
  }
}
