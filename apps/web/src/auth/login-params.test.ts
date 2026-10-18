import { describe, expect, it } from 'vitest';
import { safeAlias, safePath } from './login-params';

describe('safePath', () => {
  it.each(['/dashboard', '/documents/1', '/a-b/c.d'])('keeps %s', (p) =>
    expect(safePath(p)).toBe(p),
  );
  it.each([
    '//evil.com',
    '/\\evil.com',
    'https://evil.com',
    'javascript:alert(1)',
    '/a?b=1',
    '',
    undefined,
  ])('falls back to /dashboard for %s', (p) => expect(safePath(p)).toBe('/dashboard'));
});

describe('safeAlias', () => {
  it('accepts organization aliases', () => expect(safeAlias('globex-2')).toBe('globex-2'));
  it.each(['a b', 'acme organization:*', 'ACME', 'a;b', '', 'x'.repeat(65), undefined])(
    'rejects %s',
    (a) => expect(safeAlias(a)).toBeUndefined(),
  );
});
