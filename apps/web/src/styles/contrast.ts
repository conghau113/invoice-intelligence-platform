// WCAG 2.x contrast ratio for #rrggbb colours; used by contrast.test.ts to judge tokens.css.
function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new RangeError(`expected #rrggbb, got ${hex}`);
  const n = Number.parseInt(m[1] ?? '', 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Reads `--name: #hex;` declarations from the block opened by `selector` in a CSS string. */
export function readTokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector ${selector} not found`);
  const end = css.indexOf('\n}', start);
  const out: Record<string, string> = {};
  // Line by line, no regex over the whole block (a nested quantifier would backtrack).
  for (const raw of css.slice(start, end).split('\n')) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (!line.startsWith('--') || colon < 0 || !line.endsWith(';')) continue;
    const value = line.slice(colon + 1, -1).trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) out[line.slice(2, colon)] = value;
  }
  return out;
}
