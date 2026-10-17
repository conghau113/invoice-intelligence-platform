import { validateEnv } from './env.schema';

const ISSUER = 'http://localhost:8080/realms/invoice';
const DB_URL = 'postgres://invoice_app:pw@localhost:5433/invoice';

describe('validateEnv', () => {
  it('applies defaults', () => {
    expect(
      validateEnv({ NODE_ENV: 'test', OIDC_ISSUER_URL: ISSUER, DATABASE_URL: DB_URL }),
    ).toEqual({
      NODE_ENV: 'test',
      PORT: 3001,
      DEMO_READ_ONLY: false,
      OIDC_ISSUER_URL: ISSUER,
      DATABASE_URL: DB_URL,
      OIDC_AUDIENCE: 'api',
    });
  });

  it('parses "false" as false (not a truthy string)', () => {
    const base = { NODE_ENV: 'test', OIDC_ISSUER_URL: ISSUER, DATABASE_URL: DB_URL };
    expect(validateEnv({ ...base, DEMO_READ_ONLY: 'false' }).DEMO_READ_ONLY).toBe(false);
    expect(validateEnv({ ...base, DEMO_READ_ONLY: 'true' }).DEMO_READ_ONLY).toBe(true);
  });

  it('requires the token issuer (no silent insecure default)', () => {
    expect(() => validateEnv({ NODE_ENV: 'test' })).toThrow(/OIDC_ISSUER_URL/);
  });

  it('requires the database url and never prints it', () => {
    expect.assertions(2);
    expect(() => validateEnv({ NODE_ENV: 'test', OIDC_ISSUER_URL: ISSUER })).toThrow(
      /DATABASE_URL/,
    );
    try {
      validateEnv({ NODE_ENV: 'test', OIDC_ISSUER_URL: ISSUER, DATABASE_URL: 'not-a-url-secret' });
    } catch (e) {
      expect((e as Error).message).not.toContain('not-a-url-secret');
    }
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
