import { NextResponse, type NextRequest } from 'next/server';
import { encode, getToken } from 'next-auth/jwt';
import { authEnv } from '@/auth/env';
import {
  chunkCookie,
  isSessionCookie,
  replaceSessionCookies,
  sessionCookieName,
} from '@/auth/cookie';
import { decide } from '@/auth/guard';
import { needsRefresh, refreshAccessToken } from '@/auth/refresh';

// Same as next-auth's default session maxAge.
const MAX_AGE = 30 * 24 * 60 * 60;

function toLogin(req: NextRequest, base: string): NextResponse {
  const url = new URL('/login', req.url);
  url.searchParams.set('callbackUrl', req.nextUrl.pathname);
  const res = NextResponse.redirect(url);
  for (const c of req.cookies.getAll())
    if (isSessionCookie(c.name, base)) res.cookies.delete(c.name);
  return res;
}

// Next 16 "proxy" (ex-middleware). Server Components cannot set cookies, so the
// refreshed (rotated) token must be written here, before the page renders.
export default async function proxy(req: NextRequest) {
  // Public paths (login, auth endpoints, health) must work even if auth env is broken.
  if (decide(req.nextUrl.pathname, false) === 'allow') return NextResponse.next();

  const env = authEnv();
  const base = sessionCookieName(env.NEXTAUTH_URL);
  const token = await getToken({ req, secret: env.NEXTAUTH_SECRET });

  if (!token) return toLogin(req, base);
  if (!needsRefresh(token)) return NextResponse.next();

  const result = await refreshAccessToken(token, {
    issuer: env.KEYCLOAK_ISSUER,
    clientId: env.KEYCLOAK_CLIENT_ID,
    clientSecret: env.KEYCLOAK_CLIENT_SECRET,
  });
  // Keycloak down: keep the session (the API will reject the expired token) instead of logging out.
  if (result.kind === 'unavailable') return NextResponse.next();
  if (result.kind === 'rejected') return toLogin(req, base);

  const fresh = chunkCookie(
    base,
    await encode({ token: result.token, secret: env.NEXTAUTH_SECRET, maxAge: MAX_AGE }),
  );
  const headers = new Headers(req.headers);
  headers.set('cookie', replaceSessionCookies(req.headers.get('cookie') ?? '', base, fresh));
  const res = NextResponse.next({ request: { headers } });
  for (const c of req.cookies.getAll()) {
    if (isSessionCookie(c.name, base) && !(c.name in fresh)) res.cookies.delete(c.name);
  }
  for (const [name, value] of Object.entries(fresh)) {
    res.cookies.set(name, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NEXTAUTH_URL.startsWith('https://'),
      path: '/',
      maxAge: MAX_AGE,
    });
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
