/**
 * Maps the Keycloak organization alias to our tenant UUID. The token carries only the alias.
 * Static for now (UUIDs fixed in infra/keycloak/realm-invoice.json); T1.3 replaces this with a
 * lookup in the `tenants` table.
 */
const TENANTS: Readonly<Record<string, string>> = {
  acme: '00000000-0000-4000-8000-0000000000a1',
  globex: '00000000-0000-4000-8000-0000000000a2',
};

export function tenantIdForAlias(alias: string): string | undefined {
  return Object.hasOwn(TENANTS, alias) ? TENANTS[alias] : undefined;
}
