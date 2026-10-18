export const KNOWN_ROLES = ['tenant_admin', 'accountant', 'viewer'] as const;
export type Role = (typeof KNOWN_ROLES)[number];

/** The authenticated caller. Built only from a verified token, never from request headers. */
export interface AuthUser {
  userId: string;
  /** Organization alias from the token (e.g. "acme"). */
  tenantAlias: string;
  tenantId: string;
  /** Aliases of every tenant the token's organization claim lists: what the user may switch to. */
  memberOf: readonly string[];
  roles: readonly Role[];
}
