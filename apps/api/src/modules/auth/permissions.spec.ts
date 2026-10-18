import type { Role } from './domain/auth-user';
import { PERMISSIONS, permissionsOf, ROLE_PERMISSIONS, type Permission } from './permissions';

/** Written independently of the implementation, straight from SECURITY.md §3. */
const EXPECTED: Record<Permission, Role[]> = {
  'document:read': ['tenant_admin', 'accountant', 'viewer'],
  'document:create': ['tenant_admin', 'accountant'],
  'document:approve': ['tenant_admin', 'accountant'],
  'document:manage': ['tenant_admin'],
  'qa:ask': ['tenant_admin', 'accountant', 'viewer'],
  'insights:read': ['tenant_admin', 'accountant', 'viewer'],
  'tenant:manage': ['tenant_admin'],
};
const ROLES: Role[] = ['tenant_admin', 'accountant', 'viewer'];

describe('role x permission matrix', () => {
  const cases = ROLES.flatMap((role) =>
    PERMISSIONS.map((perm) => [role, perm, EXPECTED[perm].includes(role)] as const),
  );

  it.each(cases)('%s / %s -> %s', (role, perm, allowed) => {
    expect(permissionsOf([role]).includes(perm)).toBe(allowed);
  });

  it('covers every permission and every role', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PERMISSIONS].sort());
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  it('viewer holds no write permission', () => {
    expect(permissionsOf(['viewer'])).toEqual(['document:read', 'qa:ask', 'insights:read']);
  });

  it('unions several roles and grants nothing for no role', () => {
    expect(permissionsOf(['viewer', 'accountant'])).toEqual(permissionsOf(['accountant']));
    expect(permissionsOf([])).toEqual([]);
  });
});
