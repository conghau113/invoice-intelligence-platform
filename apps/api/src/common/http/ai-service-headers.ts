import { currentLogContext } from 'logger';
import { isUuid } from '../uuid';

/** Header name the AI service reads (API.md). Lower case, as fetch sends it. */
export const TENANT_HEADER = 'x-tenant-id';

/**
 * Headers of every call to the AI service: the shared bearer token, and the tenant of the current
 * request or job (T7.2) so the AI service's log lines carry the same `tenant_id`. For logs only:
 * the AI service is stateless and never authorises by it. Not sent through W3C baggage, which the
 * AI service's httpx instrumentation would pass on to the LLM provider.
 */
export function aiServiceHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...extra };
  const { tenantId } = currentLogContext();
  if (tenantId !== undefined && isUuid(tenantId)) headers[TENANT_HEADER] = tenantId;
  return headers;
}
