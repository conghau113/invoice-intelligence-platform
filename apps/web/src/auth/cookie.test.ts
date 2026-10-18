import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, chunkCookie, replaceSessionCookies, sessionCookieName } from './cookie';

describe('cookie helpers', () => {
  it('names the cookie with __Secure- only on https', () => {
    expect(sessionCookieName('http://localhost:3000')).toBe('next-auth.session-token');
    expect(sessionCookieName('https://x.example')).toBe('__Secure-next-auth.session-token');
  });
  it('keeps small values in one cookie and splits big ones losslessly', () => {
    expect(chunkCookie('n', 'abc')).toEqual({ n: 'abc' });
    const big = 'x'.repeat(CHUNK_SIZE * 2 + 5);
    const parts = chunkCookie('n', big);
    expect(Object.keys(parts)).toEqual(['n.0', 'n.1', 'n.2']);
    expect(Object.values(parts).join('')).toBe(big);
  });
  it('replaces old session chunks and keeps unrelated cookies', () => {
    const out = replaceSessionCookies('a=1; n.0=old0; n.1=old1; b=2', 'n', { n: 'new' });
    expect(out).toBe('a=1; b=2; n=new');
  });
});
