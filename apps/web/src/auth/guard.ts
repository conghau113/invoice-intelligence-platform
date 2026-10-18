const PUBLIC_PREFIXES = ['/login', '/api/auth', '/api/health'];

export type GuardDecision = 'allow' | 'login';

/** Optimistic check from the cookie only (no network): the API still enforces. */
export function decide(pathname: string, signedIn: boolean): GuardDecision {
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return isPublic || signedIn ? 'allow' : 'login';
}
