import { describe, expect, it } from 'vitest';
import { nextTheme, parseTheme, themeCookie } from './theme';

describe('theme', () => {
  it.each([
    ['dark', 'dark'],
    ['light', 'light'],
    [undefined, 'light'],
    ['DARK', 'light'],
    ['"><script>', 'light'],
  ])('parseTheme(%s) = %s', (input, expected) => {
    expect(parseTheme(input)).toBe(expected);
  });

  it('toggles and serialises as a lax, year-long cookie', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
    expect(themeCookie('dark')).toBe('theme=dark; path=/; max-age=31536000; samesite=lax');
  });
});
