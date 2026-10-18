import { describe, expect, it } from 'vitest';
import { decide } from './guard';

describe('decide', () => {
  it.each(['/dashboard', '/', '/documents/1'])('sends signed-out users from %s to login', (p) => {
    expect(decide(p, false)).toBe('login');
  });
  it.each(['/login', '/api/auth/session', '/api/auth/callback/keycloak', '/api/health'])(
    'lets %s through when signed out',
    (p) => expect(decide(p, false)).toBe('allow'),
  );
  it('does not treat lookalike prefixes as public', () => {
    expect(decide('/login-evil', false)).toBe('login');
    expect(decide('/api/authx', false)).toBe('login');
  });
  it('allows everything when signed in', () => {
    expect(decide('/dashboard', true)).toBe('allow');
  });
});
