import type { NextAuthOptions } from 'next-auth';
import KeycloakProvider from 'next-auth/providers/keycloak';
import { authEnv } from './env';
import { tenantsFromClaim } from './tenant';

interface AccessClaims {
  organization?: Record<string, unknown> | string[];
  realm_access?: { roles?: string[] };
}

const KNOWN_ROLES = new Set(['tenant_admin', 'accountant', 'viewer']);

function decodeClaims(accessToken: string): AccessClaims {
  // Decoding (not verifying) is fine here: the token just came from Keycloak over
  // the back channel; the API verifies signatures on every call.
  const payload = accessToken.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessClaims;
}

export function buildAuthOptions(): NextAuthOptions {
  const env = authEnv();
  return {
    secret: env.NEXTAUTH_SECRET,
    session: { strategy: 'jwt' },
    pages: { signIn: '/login' },
    providers: [
      KeycloakProvider({
        issuer: env.KEYCLOAK_ISSUER,
        clientId: env.KEYCLOAK_CLIENT_ID,
        clientSecret: env.KEYCLOAK_CLIENT_SECRET,
        // organization:* = every tenant the user belongs to; the UI picks one (cookie) and the API
        // checks it against this signed claim (X-Tenant).
        authorization: { params: { scope: 'openid organization:*' } },
        checks: ['pkce', 'state'],
      }),
    ],
    callbacks: {
      jwt({ token, account }) {
        if (account?.access_token) {
          const claims = decodeClaims(account.access_token);
          return {
            ...token,
            accessToken: account.access_token,
            refreshToken: account.refresh_token,
            idToken: account.id_token,
            expiresAt: account.expires_at,
            tenants: tenantsFromClaim(claims.organization),
            roles: (claims.realm_access?.roles ?? []).filter((r) => KNOWN_ROLES.has(r)),
          };
        }
        // No refresh here: a callback running in a Server Component cannot store a rotated
        // refresh token (cookies are read-only there). Refresh happens in proxy.ts only.
        return token;
      },
      session({ session, token }) {
        // Never copy accessToken/refreshToken/idToken here: this object reaches the browser.
        session.tenants = token.tenants ?? [];
        session.roles = token.roles ?? [];
        return session;
      },
    },
  };
}
