const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Any 8-4-4-4-12 hex uuid. A malformed id never reaches the API: the route answers 404 itself. */
export const isUuid = (value: string): boolean => UUID.test(value);
