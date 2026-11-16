import { RealtimeTokenSchema } from 'contracts';
import { z } from 'zod';

const AnswerSchema = RealtimeTokenSchema.extend({ url: z.url() });

export type TokenResult =
  | { kind: 'ok'; token: string; url: string }
  /** Realtime is off here (not configured, the read-only demo) or not for this user: poll. */
  | { kind: 'off' }
  /** The session is gone: no point in reconnecting until the person signs in again. */
  | { kind: 'signed-out' }
  /** Network or server trouble: try again later. */
  | { kind: 'error' };

/** A web server that does not answer must not leave the connection waiting forever. */
export const TOKEN_TIMEOUT_MS = 10_000;

/** Asks the web server (BFF) for a handshake token. Never throws, never waits more than 10 s. */
export async function fetchRealtimeToken(
  fetcher: typeof fetch = fetch,
  timeoutMs = TOKEN_TIMEOUT_MS,
): Promise<TokenResult> {
  let res: Response;
  try {
    res = await fetcher('/api/realtime/token', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: 'error' };
  }
  if (res.status === 404 || res.status === 403) return { kind: 'off' };
  if (res.status === 401) return { kind: 'signed-out' };
  if (!res.ok) return { kind: 'error' };
  // The body is read under the same timeout: an aborted read rejects, which counts as an error.
  const parsed = AnswerSchema.safeParse(await res.json().catch(() => null));
  return parsed.success
    ? { kind: 'ok', token: parsed.data.token, url: parsed.data.url }
    : { kind: 'error' };
}
