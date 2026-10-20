/** How long a key keeps replaying the original response (API.md, Conventions). */
export const IDEMPOTENCY_WINDOW_HOURS = 24;

export const IDEMPOTENCY_KEY_REQUIRED = 'IDEMPOTENCY_KEY_REQUIRED';
export const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED';

const MAX_KEY_LENGTH = 255;

/**
 * The header value if it is a usable key, else `null`. Printable ASCII only (no spaces, no
 * control characters), 1 to 255 characters: the key is stored and compared as-is, so it must not
 * carry anything that surprises a log line or a query.
 */
export function parseIdempotencyKey(header: unknown): string | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_KEY_LENGTH) {
    return null;
  }
  for (let i = 0; i < header.length; i++) {
    const code = header.codePointAt(i) ?? 0;
    if (code < 0x21 || code > 0x7e) return null;
  }
  return header;
}
