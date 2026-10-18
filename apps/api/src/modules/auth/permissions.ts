import type { Role } from './domain/auth-user';

/**
 * The single source of truth for RBAC (docs/architecture/SECURITY.md §3).
 *
 * Roles are Keycloak realm roles, not per organization (T1.1): a user who belongs to two tenants
 * has the same permissions in both. Accepted for the MVP; per-tenant roles would need memberships
 * in the DB.
 */
export const PERMISSIONS = [
  'document:read',
  'document:create',
  'document:approve',
  'document:manage',
  'qa:ask',
  'insights:read',
  'tenant:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: readonly Permission[] = ['document:read', 'qa:ask', 'insights:read'];
const ACCOUNTANT: readonly Permission[] = [...READ_ONLY, 'document:create', 'document:approve'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  tenant_admin: [...ACCOUNTANT, 'document:manage', 'tenant:manage'],
  accountant: ACCOUNTANT,
  viewer: READ_ONLY,
};

/** Union over the user's roles (least privilege: no role, no permission). */
export function permissionsOf(roles: readonly Role[]): Permission[] {
  const granted = new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []));
  return PERMISSIONS.filter((p) => granted.has(p));
}
