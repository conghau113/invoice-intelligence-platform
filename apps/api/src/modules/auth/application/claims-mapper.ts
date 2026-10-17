import { ForbiddenException } from '@nestjs/common';
import { isUuid } from '../../../common/uuid';
import { KNOWN_ROLES, type AuthUser, type Role } from '../domain/auth-user';
import type { TenantDirectory } from './tenant-directory.port';
import type { TokenClaims } from './token-verifier.port';

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Verified claims -> AuthUser. The tenant comes only from the `organization` claim and its alias
 * is resolved through the tenants table. A token with no tenant, several tenants (T1.7 will select
 * one at login) or an unknown tenant is refused (403: the identity is valid, but it cannot act for
 * exactly one tenant). Messages never echo claims.
 */
export async function mapClaimsToUser(
  claims: TokenClaims,
  tenants: TenantDirectory,
): Promise<AuthUser> {
  const { sub, organization, realm_access: realmAccess } = claims;
  // users.id and every actor column are uuid, and Keycloak's `sub` is one.
  if (!isUuid(sub)) {
    throw new ForbiddenException('Invalid token subject');
  }

  if (!isStringArray(organization) || organization.length === 0) {
    throw new ForbiddenException('Token has no tenant');
  }
  const [tenantAlias, ...others] = organization;
  if (others.length > 0) throw new ForbiddenException('Token must select exactly one tenant');
  const tenantId = tenantAlias === undefined ? undefined : await tenants.idForAlias(tenantAlias);
  if (tenantAlias === undefined || tenantId === undefined) {
    throw new ForbiddenException('Unknown tenant');
  }

  const rawRoles = (realmAccess as { roles?: unknown } | undefined)?.roles;
  const roles = isStringArray(rawRoles)
    ? KNOWN_ROLES.filter((r): r is Role => rawRoles.includes(r))
    : [];

  return { userId: sub, tenantAlias, tenantId, roles };
}
