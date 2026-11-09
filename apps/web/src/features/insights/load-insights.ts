import 'server-only';
import { ExtractionInsightsSchema, type ExtractionInsights } from 'contracts';
import { apiGet } from '@/lib/api';

/** Why the page has no numbers to show, in the terms it explains to the user. */
export type InsightsLoadError = 'session' | 'forbidden' | 'unreachable' | 'error';

export type InsightsLoad =
  { kind: 'ok'; data: ExtractionInsights } | { kind: 'error'; error: InsightsLoadError };

/**
 * Server side: GET /insights/extraction with the user's token and tenant (the browser never sees
 * the token). The body is checked against the shared contract, so the page never renders a shape
 * it did not expect.
 */
export async function loadInsights(): Promise<InsightsLoad> {
  const res = await apiGet<unknown>('/insights/extraction');
  if (res.kind === 'unauthorized') return { kind: 'error', error: 'session' };
  if (res.kind === 'forbidden') return { kind: 'error', error: 'forbidden' };
  if (res.kind === 'unavailable') return { kind: 'error', error: 'unreachable' };
  const parsed = ExtractionInsightsSchema.safeParse(res.data);
  return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error', error: 'error' };
}
