import { describe, expect, it } from 'vitest';
import { decide, localePrefix, stripLocale } from './guard';

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
  it.each(['/vi/login', '/en/login'])('treats %s as public after the locale', (p) =>
    expect(decide(p, false)).toBe('allow'),
  );
  it.each(['/vi/dashboard', '/en', '/vi', '/en/api/auth/x'])(
    'sends signed-out users from %s to login',
    (p) => expect(decide(p, false)).toBe('login'),
  );
  it('only strips exact locale segments', () => {
    expect(stripLocale('/viet/login')).toBe('/viet/login');
    expect(decide('/viet/login', false)).toBe('login');
    expect(stripLocale('/en/documents/1')).toBe('/documents/1');
    expect(stripLocale('/vi')).toBe('/');
  });
});

describe('localePrefix', () => {
  it.each([
    ['/vi', '/vi'],
    ['/en/dashboard', '/en'],
    ['/viet/login', ''],
    ['/login', ''],
  ])('%s -> "%s"', (path, expected) => expect(localePrefix(path)).toBe(expected));
});
