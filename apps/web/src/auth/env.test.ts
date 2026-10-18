import { describe, expect, it } from 'vitest';
import { authEnv } from './env';

const ok = {
  NEXTAUTH_URL: 'http://localhost:3000',
  NEXTAUTH_SECRET: 'x'.repeat(32),
  KEYCLOAK_ISSUER: 'http://localhost:8080/realms/invoice',
  KEYCLOAK_CLIENT_ID: 'web',
  KEYCLOAK_CLIENT_SECRET: 'secret',
};

describe('authEnv', () => {
  it('accepts a complete environment', () => {
    expect(authEnv(ok).KEYCLOAK_CLIENT_ID).toBe('web');
  });
  it('rejects a short secret and never echoes values', () => {
    let msg = '';
    try {
      authEnv({ ...ok, NEXTAUTH_SECRET: 'short-secret-value' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('NEXTAUTH_SECRET');
    expect(msg).not.toContain('short-secret-value');
  });
  it('rejects a missing variable', () => {
    const rest: Record<string, string> = { ...ok };
    delete rest.KEYCLOAK_ISSUER;
    expect(() => authEnv(rest)).toThrow(/KEYCLOAK_ISSUER/);
  });
});
