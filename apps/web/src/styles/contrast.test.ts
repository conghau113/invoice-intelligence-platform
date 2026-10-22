import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, readTokens } from './contrast';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

// [foreground token, background token, minimum ratio]: 4.5 for text, 3 for UI boundaries.
const PAIRS: [string, string, number][] = [
  ['foreground', 'background', 4.5],
  ['card-foreground', 'card', 4.5],
  ['popover-foreground', 'popover', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['secondary-foreground', 'secondary', 4.5],
  ['muted-foreground', 'background', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['muted-foreground', 'card', 4.5],
  ['accent-foreground', 'accent', 4.5],
  ['destructive', 'background', 4.5],
  ['destructive', 'card', 4.5],
  ['destructive-foreground', 'destructive', 4.5],
  ['success', 'card', 4.5],
  ['warning', 'card', 4.5],
  ['info', 'card', 4.5],
  ['success-soft-foreground', 'success-soft', 4.5],
  ['warning-soft-foreground', 'warning-soft', 4.5],
  ['info-soft-foreground', 'info-soft', 4.5],
  ['danger-soft-foreground', 'danger-soft', 4.5],
  ['neutral-soft-foreground', 'neutral-soft', 4.5],
  ['sidebar-foreground', 'sidebar', 4.5],
  ['sidebar-primary-foreground', 'sidebar-primary', 4.5],
  ['sidebar-accent-foreground', 'sidebar-accent', 4.5],
  ['nav-active-foreground', 'nav-active', 4.5],
  ['muted-foreground', 'table-header', 4.5],
  ['foreground', 'table-row-alt', 4.5],
  ['foreground', 'table-row-hover', 4.5],
  ['scroll-thumb', 'scroll-track', 3],
  ['nav-active', 'sidebar', 3],
  ['ring', 'background', 3],
  ['ring', 'card', 3],
  ['input', 'background', 3],
  ['input', 'card', 3],
];

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('rejects a pair that is too weak (the gate can fail)', () => {
    const fails = (fg: string, bg: string, min: number) => contrastRatio(fg, bg) < min;
    expect(fails('#94a3b8', '#ffffff', 4.5)).toBe(true); // slate-400 text on white, ~2.6:1
    expect(fails('#059669', '#ffffff', 4.5)).toBe(true); // the raw skill "paid green" as text, ~3.8:1
  });

  it('refuses values that are not #rrggbb', () => {
    expect(() => contrastRatio('red', '#fff')).toThrow(RangeError);
  });
});

describe.each([':root', '.dark'])('tokens.css %s', (selector) => {
  const tokens = readTokens(css, selector);

  const token = (name: string): string => {
    const value = tokens[name];
    if (!value) throw new Error(`missing --${name}`);
    return value;
  };

  it.each(PAIRS)('%s on %s is at least %s:1', (fg, bg, min) => {
    expect(contrastRatio(token(fg), token(bg))).toBeGreaterThanOrEqual(min);
  });
});
