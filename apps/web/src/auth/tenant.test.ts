import { describe, expect, it } from 'vitest';
import { resolveTenant, tenantsFromClaim } from './tenant';

describe('tenantsFromClaim', () => {
  it('reads both shapes Keycloak can send', () => {
    expect(tenantsFromClaim(['acme', 'globex'])).toEqual(['acme', 'globex']);
    expect(tenantsFromClaim({ acme: { id: 'x' }, globex: {} })).toEqual(['acme', 'globex']);
  });
  it('sorts and de-duplicates, whatever order Keycloak sends', () =>
    expect(tenantsFromClaim(['globex', 'acme', 'acme'])).toEqual(['acme', 'globex']));
  it.each([undefined, null, 'acme', 42, [1, {}]])('gives no tenants for %j', (v) =>
    expect(tenantsFromClaim(v)).toEqual([]),
  );
});

describe('resolveTenant', () => {
  const tenants = ['acme', 'globex'];
  it('honours a cookie that names one of the user tenants', () =>
    expect(resolveTenant('globex', tenants)).toBe('globex'));
  it.each([undefined, '', 'initech', 'ACME', '__proto__'])(
    'falls back to the first tenant for cookie %j',
    (c) => expect(resolveTenant(c, tenants)).toBe('acme'),
  );
  it('has no tenant when the token has none', () =>
    expect(resolveTenant('acme', [])).toBeUndefined());
});
