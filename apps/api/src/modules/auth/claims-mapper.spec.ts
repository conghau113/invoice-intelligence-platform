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
  ])('refuses a token whose organization claim is %s', async (_name, organization) => {
    await expect(mapClaimsToUser({ sub: SUB, organization }, directory)).rejects.toThrow(
      ForbiddenException,
    );
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
