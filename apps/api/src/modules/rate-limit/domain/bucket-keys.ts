import type { RateLimitClass } from './policies';

/**
 * Redis keys of the two buckets a request takes from. Built only from the verified token's user id
 * and the tenant id the API resolved, never from a header the client sends.
 *
 * `{tenantId}` is a Redis Cluster hash tag: only the part in braces picks the slot, so both keys of
 * one request live on the same node and one script may touch them both. `v1` lets a change of the
 * stored format start from fresh keys instead of reading old ones.
 */
export function bucketKeys(
  tenantId: string,
  userId: string,
  cls: RateLimitClass,
): { userKey: string; tenantKey: string } {
  const prefix = `rl:v1:{${tenantId}}`;
  return { userKey: `${prefix}:u:${userId}:${cls}`, tenantKey: `${prefix}:t:${cls}` };
}
