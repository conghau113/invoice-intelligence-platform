import { ForbiddenException } from '@nestjs/common';
import { isUuid } from '../../../common/uuid';
import { KNOWN_ROLES, type AuthUser, type Role } from '../domain/auth-user';
import type { TenantDirectory } from './tenant-directory.port';
import type { TokenClaims } from './token-verifier.port';

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Verified claims -> AuthUser. The set of tenants the caller may act for is the signed
 * `organization` claim (membership is decided by Keycloak). `requestedAlias` is the user's choice
 * (X-Tenant header): it is honoured only if it is in that set, so it is a selector, never a grant.
 * Without a choice the token must carry exactly one tenant. Refusals are 403 (the identity is
 * valid, but it cannot act for exactly one tenant) with a stable `code`; messages never echo
 * claims or the header.
 */
export async function mapClaimsToUser(
  claims: TokenClaims,
  tenants: TenantDirectory,
  requestedAlias?: string,
): Promise<AuthUser> {
  const { sub, organization, realm_access: realmAccess } = claims;
  // users.id and every actor column are uuid, and Keycloak's `sub` is one.
  if (!isUuid(sub)) {
    throw new ForbiddenException('Invalid token subject');
  }

  if (!isStringArray(organization) || organization.length === 0) {
    throw new ForbiddenException('Token has no tenant');
  }
  // Sorted: Keycloak's order is not stable, and the UI falls back to the first tenant.
  const memberOf = [...new Set(organization)].sort();
  let tenantAlias: string | undefined;
  if (requestedAlias === undefined) {
    if (memberOf.length > 1) {
      throw new ForbiddenException({ message: 'Select a tenant', code: 'TENANT_REQUIRED' });
    }
    tenantAlias = memberOf[0];
  } else if (memberOf.includes(requestedAlias)) {
    tenantAlias = requestedAlias;
  } else {
    throw new ForbiddenException({
      message: 'Not a member of the requested tenant',
      code: 'TENANT_NOT_MEMBER',
    });
  }
  const tenantId = tenantAlias === undefined ? undefined : await tenants.idForAlias(tenantAlias);
  if (tenantAlias === undefined || tenantId === undefined) {
    throw new ForbiddenException('Unknown tenant');
  }

  const rawRoles = (realmAccess as { roles?: unknown } | undefined)?.roles;
  const roles = isStringArray(rawRoles)
    ? KNOWN_ROLES.filter((r): r is Role => rawRoles.includes(r))
    : [];

  return { userId: sub, tenantAlias, tenantId, memberOf, roles };
}
