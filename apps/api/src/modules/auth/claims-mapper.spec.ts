import { ForbiddenException } from '@nestjs/common';
import { mapClaimsToUser } from './application/claims-mapper';

const ACME_ID = '00000000-0000-4000-8000-0000000000a1';

describe('mapClaimsToUser', () => {
  it('maps sub, organization alias -> tenant id, and keeps only known roles', () => {
    const user = mapClaimsToUser({
      sub: 'u-1',
      organization: ['acme'],
      realm_access: { roles: ['viewer', 'offline_access', 'accountant', 'root'] },
    });
    expect(user).toEqual({
      userId: 'u-1',
      tenantAlias: 'acme',
      tenantId: ACME_ID,
      roles: ['accountant', 'viewer'],
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['not a list', 'acme'],
    ['several tenants', ['acme', 'globex']],
    ['unknown tenant', ['initech']],
    ['prototype key', ['__proto__']],
  ])('refuses a token whose organization claim is %s', (_name, organization) => {
    expect(() => mapClaimsToUser({ sub: 'u-1', organization })).toThrow(ForbiddenException);
  });

  it('refuses a token without subject', () => {
    expect(() => mapClaimsToUser({ organization: ['acme'] })).toThrow(ForbiddenException);
  });

  it('gives no roles when realm_access is absent', () => {
    expect(mapClaimsToUser({ sub: 'u', organization: ['globex'] }).roles).toEqual([]);
  });
});
