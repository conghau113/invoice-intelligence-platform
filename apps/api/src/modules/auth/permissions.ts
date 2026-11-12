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

/**
 * What a signed-in user may do on the public read-only demo (ADR 0018), whatever their roles.
 * Only permissions whose routes are all GET: the guard refuses every other method anyway, so
 * advertising more would show buttons that can only fail. `qa:ask` is left out until the demo
 * serves precomputed answers (moved from T5.5 to T7.5); adding it back needs a test that the
 * demo never calls the model.
 */
export const DEMO_PERMISSIONS: readonly Permission[] = ['document:read', 'insights:read'];

/** The permissions to advertise: all of `permissionsOf(roles)`, or only the demo's on the demo. */
export function effectivePermissions(roles: readonly Role[], demoReadOnly: boolean): Permission[] {
  const all = permissionsOf(roles);
  return demoReadOnly ? all.filter((p) => DEMO_PERMISSIONS.includes(p)) : all;
}
