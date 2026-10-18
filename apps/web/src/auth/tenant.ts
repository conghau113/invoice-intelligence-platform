// The tenant the user is working in. Chosen in the UI (cookie) but only ever a selector: the
// choices come from the signed token, and the API checks the choice again on every request.
export const TENANT_COOKIE = 'tenant';

// Keycloak 26 sends `organization` as an object keyed by alias, or as a list of aliases. Sorted and
// de-duplicated like the API's list, so "the first tenant" means the same thing on both sides.
export function tenantsFromClaim(org: unknown): string[] {
  let aliases: string[] = [];
  if (Array.isArray(org)) aliases = org.filter((a): a is string => typeof a === 'string');
  else if (typeof org === 'object' && org !== null) aliases = Object.keys(org);
  return [...new Set(aliases)].sort((a, b) => a.localeCompare(b, 'en'));
}

/** Cookie value if it is one of the user's tenants, else their first one (or undefined). */
export function resolveTenant(
  cookie: string | undefined,
  tenants: readonly string[],
): string | undefined {
  return cookie !== undefined && tenants.includes(cookie) ? cookie : tenants[0];
}
