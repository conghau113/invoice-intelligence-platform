const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Any 8-4-4-4-12 hex uuid (Keycloak `sub`, tenant ids). */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
