import { validateEnv } from './env.schema';

const ISSUER = 'http://localhost:8080/realms/invoice';

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(validateEnv({ NODE_ENV: 'test', OIDC_ISSUER_URL: ISSUER })).toEqual({
      NODE_ENV: 'test',
      PORT: 3001,
      DEMO_READ_ONLY: false,
      OIDC_ISSUER_URL: ISSUER,
      OIDC_AUDIENCE: 'api',
    });
  });

  it('parses "false" as false (not a truthy string)', () => {
    const base = { NODE_ENV: 'test', OIDC_ISSUER_URL: ISSUER };
    expect(validateEnv({ ...base, DEMO_READ_ONLY: 'false' }).DEMO_READ_ONLY).toBe(false);
    expect(validateEnv({ ...base, DEMO_READ_ONLY: 'true' }).DEMO_READ_ONLY).toBe(true);
  });

  it('requires the token issuer (no silent insecure default)', () => {
    expect(() => validateEnv({ NODE_ENV: 'test' })).toThrow(/OIDC_ISSUER_URL/);
  });

  it('names every invalid variable but never prints its value', () => {
    expect.assertions(3);
    try {
      validateEnv({ PORT: 'abc-secret' });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('NODE_ENV');
      expect(msg).toContain('PORT');
      expect(msg).not.toContain('abc-secret');
    }
  });
});
