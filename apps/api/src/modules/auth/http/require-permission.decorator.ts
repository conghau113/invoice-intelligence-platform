import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../permissions';

export const REQUIRED_PERMISSIONS = 'requiredPermissions';
export const ANY_AUTHENTICATED = 'anyAuthenticated';

/** The caller must hold ALL listed permissions. */
export const RequirePermission = (
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * Explicit opt-in for routes any logged-in user may call (e.g. /auth/me, own notifications).
 * A route with none of @Public, @RequirePermission or this is refused: deny by default.
 */
export const AnyAuthenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ANY_AUTHENTICATED, true);
