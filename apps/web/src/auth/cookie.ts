// next-auth v4 stores big JWTs as `<name>.0`, `<name>.1`, ... (4096-byte cookie limit).
// The proxy re-issues the session cookie after a refresh, so it must chunk the same way.
export const CHUNK_SIZE = 3933;

export function sessionCookieName(appUrl: string): string {
  return `${appUrl.startsWith('https://') ? '__Secure-' : ''}next-auth.session-token`;
}

export function chunkCookie(name: string, value: string): Record<string, string> {
  if (value.length <= CHUNK_SIZE) return { [name]: value };
  const out: Record<string, string> = {};
  for (let i = 0; i * CHUNK_SIZE < value.length; i++) {
    out[`${name}.${i}`] = value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
  }
  return out;
}

export function isSessionCookie(cookieName: string, base: string): boolean {
  return cookieName === base || cookieName.startsWith(`${base}.`);
}

/** Cookie header for the downstream request: old session chunks dropped, new ones added. */
export function replaceSessionCookies(
  cookieHeader: string,
  base: string,
  fresh: Record<string, string>,
): string {
  const kept = cookieHeader
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !isSessionCookie(p.split('=')[0] ?? '', base));
  return [...kept, ...Object.entries(fresh).map(([k, v]) => `${k}=${v}`)].join('; ');
}
