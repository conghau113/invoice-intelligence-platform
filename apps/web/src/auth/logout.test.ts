import { describe, expect, it } from 'vitest';
import { buildEndSessionUrl, isSameOrigin } from './logout';

describe('buildEndSessionUrl', () => {
  it('targets end_session with hint, client and redirect', () => {
    const u = new URL(
      buildEndSessionUrl({
        issuer: 'http://kc/realms/invoice',
        clientId: 'web',
        idToken: 'IDT',
        postLogoutRedirectUri: 'http://localhost:3000/login',
      }),
    );
    expect(u.pathname).toBe('/realms/invoice/protocol/openid-connect/logout');
    expect(u.searchParams.get('id_token_hint')).toBe('IDT');
    expect(u.searchParams.get('client_id')).toBe('web');
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000/login');
  });
  it('omits id_token_hint when there is no id token', () => {
    const u = new URL(
      buildEndSessionUrl({
        issuer: 'http://kc/r',
        clientId: 'web',
        postLogoutRedirectUri: 'http://a/b',
      }),
    );
    expect(u.searchParams.has('id_token_hint')).toBe(false);
  });
});

describe('isSameOrigin', () => {
  it('accepts only the app origin', () => {
    expect(isSameOrigin('http://localhost:3000', 'http://localhost:3000')).toBe(true);
    expect(isSameOrigin('http://evil.example', 'http://localhost:3000')).toBe(false);
    expect(isSameOrigin(null, 'http://localhost:3000')).toBe(false);
  });
});
