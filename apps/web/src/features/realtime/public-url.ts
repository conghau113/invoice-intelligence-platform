// No 'server-only' here: proxy.ts reads the same origin to allow it in the CSP (T7.4). It only reads
// process.env, which the browser bundle never has.

/** Local default, like `apiBaseUrl`: `pnpm dev:api` listens there. */
const DEV_REALTIME_URL = 'http://localhost:3001';

/**
 * Where browsers open the socket: the API's public origin. Server-only and read at request time,
 * so one build serves any deployment. Outside production it defaults to the local API. In
 * production, not set or not a bare http(s) origin = realtime off: the token route answers 404 and
 * the web keeps polling (the public demo, which has no public route to the API).
 */
export function realtimePublicUrl(
  raw = process.env.REALTIME_PUBLIC_URL,
  production = process.env.NODE_ENV === 'production',
): string | null {
  if (raw === undefined || raw === '') return production ? null : DEV_REALTIME_URL;
  try {
    const url = new URL(raw);
    const bare = url.origin === raw && (url.protocol === 'http:' || url.protocol === 'https:');
    return bare ? raw : null;
  } catch {
    return null;
  }
}
