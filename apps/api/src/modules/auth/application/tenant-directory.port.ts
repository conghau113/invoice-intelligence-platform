export const TENANT_DIRECTORY = Symbol('TENANT_DIRECTORY');

export interface TenantDirectory {
  /** Tenant id for a Keycloak organization alias, or undefined when no such tenant exists. */
  idForAlias(alias: string): Promise<string | undefined>;
}
