import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, createNonce } from './csp';

const base = {
  nonce: 'bm9uY2U=',
  dev: false,
  realtimeUrl: null,
  issuerUrl: 'https://demo.example/auth/realms/invoice',
  appUrl: 'https://demo.example',
};

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split('; ').map((d) => {
      const [name, ...values] = d.split(' ');
      return [name!, values];
    }),
  );
}

describe('contentSecurityPolicy', () => {
  it('allows only scripts carrying this response nonce, never inline or eval in production', () => {
    const script = directives(contentSecurityPolicy(base)).get('script-src')!;
    expect(script).toEqual(["'self'", "'nonce-bm9uY2U='", "'strict-dynamic'"]);
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it('adds eval in development only (React dev error overlay)', () => {
    const script = directives(contentSecurityPolicy({ ...base, dev: true })).get('script-src')!;
    expect(script).toContain("'unsafe-eval'");
  });

  it('keeps a nonce out of style-src, where it would switch off unsafe-inline for style attributes', () => {
    const style = directives(contentSecurityPolicy(base)).get('style-src')!;
    expect(style).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('blocks plugins, base rewriting and framing; form posts may only end at us or Keycloak', () => {
    const d = directives(contentSecurityPolicy(base));
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'self'", 'https://demo.example']);
    expect(d.has('upgrade-insecure-requests')).toBe(true);
  });

  it('opens connect-src to the realtime origin in both http and ws schemes, nothing else', () => {
    const connect = (url: string | null) =>
      directives(contentSecurityPolicy({ ...base, realtimeUrl: url })).get('connect-src');
    expect(connect(null)).toEqual(["'self'"]);
    expect(connect('http://localhost:3001')).toEqual([
      "'self'",
      'http://localhost:3001',
      'ws://localhost:3001',
    ]);
    expect(connect('https://api.example')).toEqual([
      "'self'",
      'https://api.example',
      'wss://api.example',
    ]);
  });

  it('ignores origins that are not http(s) URLs instead of writing them into the policy', () => {
    const csp = contentSecurityPolicy({
      ...base,
      realtimeUrl: 'javascript:alert(1)',
      issuerUrl: 'not a url; script-src *',
      appUrl: 'http://localhost:3000',
    });
    const d = directives(csp);
    expect(d.get('connect-src')).toEqual(["'self'"]);
    expect(d.get('form-action')).toEqual(["'self'"]);
    expect(d.has('upgrade-insecure-requests')).toBe(false);
    expect(csp).not.toContain('*');
  });
});

describe('createNonce', () => {
  it('is 16 random bytes in base64 and new every time', () => {
    const seen = new Set(Array.from({ length: 50 }, createNonce));
    expect(seen.size).toBe(50);
    for (const n of seen) expect(atob(n)).toHaveLength(16);
  });
});
