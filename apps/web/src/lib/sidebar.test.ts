import { describe, expect, it } from 'vitest';
import { parseSidebarCollapsed, sidebarCookie } from './sidebar';

describe('sidebar cookie', () => {
  it('is collapsed only for the exact value', () => {
    expect(parseSidebarCollapsed('collapsed')).toBe(true);
    for (const v of [undefined, '', 'expanded', 'Collapsed', 'true', '1'])
      expect(parseSidebarCollapsed(v)).toBe(false);
  });
  it('round-trips through the cookie string', () => {
    for (const collapsed of [true, false]) {
      const value = /^sidebar=([a-z]+);/.exec(sidebarCookie(collapsed))?.[1];
      expect(parseSidebarCollapsed(value)).toBe(collapsed);
    }
    expect(sidebarCookie(true)).toContain('samesite=lax');
  });
});
