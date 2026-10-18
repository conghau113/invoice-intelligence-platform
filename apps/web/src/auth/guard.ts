import { routing } from '@/i18n/routing';

const PUBLIC_PREFIXES = ['/login', '/api/auth', '/api/health'];

export type GuardDecision = 'allow' | 'login';

/** "/vi/dashboard" -> "/dashboard". Only exact locale segments count ("/viet/x" is left alone). */
export function stripLocale(pathname: string): string {
  for (const l of routing.locales) {
    if (pathname === `/${l}`) return '/';
    if (pathname.startsWith(`/${l}/`)) return pathname.slice(l.length + 1);
  }
  return pathname;
}

/** Optimistic check from the cookie only (no network): the API still enforces. */
export function decide(pathname: string, signedIn: boolean): GuardDecision {
  // API routes never carry a locale: "/en/api/auth/x" is a page path, not the auth endpoint.
  const path = stripLocale(pathname);
  const localizedApi = path !== pathname && path.startsWith('/api');
  const isPublic =
    !localizedApi && PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  return isPublic || signedIn ? 'allow' : 'login';
}
