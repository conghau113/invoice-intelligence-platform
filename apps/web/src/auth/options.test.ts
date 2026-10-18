import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuthOptions } from './options';

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
  vi.stubEnv('NEXTAUTH_SECRET', 'x'.repeat(40));
  vi.stubEnv('KEYCLOAK_ISSUER', 'http://kc/realms/invoice');
  vi.stubEnv('KEYCLOAK_CLIENT_ID', 'web');
  vi.stubEnv('KEYCLOAK_CLIENT_SECRET', 'cs');
});
afterEach(() => vi.unstubAllEnvs());

// An access token is header.payload.signature; only the payload matters to the callback.
const accessToken = (claims: object) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const signIn = async (claims: object) => {
  const { jwt, session } = buildAuthOptions().callbacks!;
  const token = await jwt!({
    token: {},
    account: {
      access_token: accessToken(claims),
      refresh_token: 'r',
      id_token: 'i',
      expires_at: 1,
    },
  } as never);
  return { token, session: await session!({ session: {}, token } as never) };
};

describe('sign-in callbacks', () => {
  it('asks Keycloak for every organization of the user', () => {
    const provider = buildAuthOptions().providers[0] as { options?: { authorization?: unknown } };
    expect(JSON.stringify(provider.options?.authorization)).toContain('organization:*');
  });

  it.each([
    ['a list', ['globex', 'acme']],
    ['an object keyed by alias', { globex: { id: '2' }, acme: { id: '1' } }],
  ])('keeps both tenants when organization is %s', async (_n, organization) => {
    const { token, session } = await signIn({
      organization,
      realm_access: { roles: ['accountant', 'offline_access'] },
    });
    expect(token.tenants).toEqual(['acme', 'globex']);
    expect(token.roles).toEqual(['accountant']);
    expect(session).toMatchObject({ tenants: ['acme', 'globex'], roles: ['accountant'] });
  });

  it('never copies a token into the browser-visible session', async () => {
    const { session } = await signIn({ organization: ['acme'] });
    expect(JSON.stringify(session)).not.toMatch(/accessToken|refreshToken|idToken/);
  });
});
