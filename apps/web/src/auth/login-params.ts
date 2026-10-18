// Only same-site relative paths: avoid open redirect through ?callbackUrl=.
export const safePath = (p?: string): string =>
  p && /^\/(?!\/)[\w\-./]*$/.test(p) ? p : '/dashboard';

// Tenant alias is a Keycloak organization alias: lowercase letters, digits, dash.
export const safeAlias = (a?: string): string | undefined =>
  a && /^[a-z0-9-]{1,64}$/.test(a) ? a : undefined;
