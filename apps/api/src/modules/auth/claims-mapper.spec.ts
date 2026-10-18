import { ForbiddenException } from '@nestjs/common';
import { mapClaimsToUser } from './application/claims-mapper';
import type { TenantDirectory } from './application/tenant-directory.port';

const ACME_ID = '00000000-0000-4000-8000-0000000000a1';
const SUB = '11111111-1111-4111-8111-111111111111';

// Stand-in for the tenants table; the real lookup is covered by test/db.int-spec.ts.
const directory: TenantDirectory = {
  idForAlias: (alias) =>
    Promise.resolve(
      ({ acme: ACME_ID, globex: '00000000-0000-4000-8000-0000000000a2' } as Record<string, string>)[
        alias === '__proto__' ? 'nope' : alias
      ],
    ),
};

describe('mapClaimsToUser', () => {
  it('maps sub, organization alias -> tenant id, and keeps only known roles', async () => {
    const user = await mapClaimsToUser(
      {
        sub: SUB,
        organization: ['acme'],
        realm_access: { roles: ['viewer', 'offline_access', 'accountant', 'root'] },
      },
      directory,
    );
    expect(user).toEqual({
      userId: SUB,
      tenantAlias: 'acme',
      tenantId: ACME_ID,
      memberOf: ['acme'],
      roles: ['accountant', 'viewer'],
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['not a list', 'acme'],
    ['unknown tenant', ['initech']],
    ['prototype key', ['__proto__']],
  ])('refuses a token whose organization claim is %s', async (_name, organization) => {
    await expect(mapClaimsToUser({ sub: SUB, organization }, directory)).rejects.toThrow(
      ForbiddenException,
    );
  });

  describe('tenant selection', () => {
    const both = { sub: SUB, organization: ['acme', 'globex'] };

    it('uses the requested tenant when it is in the claim', async () => {
      const user = await mapClaimsToUser(both, directory, 'globex');
      expect(user).toMatchObject({
        tenantAlias: 'globex',
        tenantId: '00000000-0000-4000-8000-0000000000a2',
        memberOf: ['acme', 'globex'],
      });
    });

    it('several tenants and no choice -> 403 TENANT_REQUIRED', async () => {
      await expect(mapClaimsToUser(both, directory)).rejects.toMatchObject({
        response: { code: 'TENANT_REQUIRED' },
      });
    });

    it.each([
      ['a tenant that exists but is not in the claim', 'globex', ['acme']],
      ['a tenant id instead of an alias', ACME_ID, ['acme', 'globex']],
      ['an empty value', '', ['acme']],
      ['a prototype key', '__proto__', ['acme']],
    ])('refuses %s -> 403 TENANT_NOT_MEMBER', async (_name, requested, organization) => {
      await expect(
        mapClaimsToUser({ sub: SUB, organization }, directory, requested),
      ).rejects.toMatchObject({ response: { code: 'TENANT_NOT_MEMBER' } });
    });

    it('a single-tenant token may name its own tenant', async () => {
      const user = await mapClaimsToUser({ sub: SUB, organization: ['acme'] }, directory, 'acme');
      expect(user.tenantAlias).toBe('acme');
    });
  });

  it.each([
    ['missing', undefined],
    ['not a uuid', 'user-1'],
    ['empty', ''],
  ])('refuses a token whose subject is %s', async (_name, sub) => {
    await expect(mapClaimsToUser({ sub, organization: ['acme'] }, directory)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('gives no roles when realm_access is absent', async () => {
    const user = await mapClaimsToUser({ sub: SUB, organization: ['globex'] }, directory);
    expect(user.roles).toEqual([]);
  });
});

it('lists the user tenants sorted and without duplicates, whatever order Keycloak sends', async () => {
  const user = await mapClaimsToUser(
    { sub: SUB, organization: ['globex', 'acme', 'acme'] },
    directory,
    'acme',
  );
  expect(user.memberOf).toEqual(['acme', 'globex']);
});
