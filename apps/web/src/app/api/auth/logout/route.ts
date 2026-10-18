import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { authEnv } from '@/auth/env';
import { isSessionCookie, sessionCookieName } from '@/auth/cookie';
import { buildEndSessionUrl, isSameOrigin } from '@/auth/logout';

export async function POST(req: NextRequest) {
  const env = authEnv();
  if (!isSameOrigin(req.headers.get('origin'), env.NEXTAUTH_URL)) {
    return NextResponse.json({ code: 'FORBIDDEN' }, { status: 403 });
  }
  const token = await getToken({ req, secret: env.NEXTAUTH_SECRET });
  const base = sessionCookieName(env.NEXTAUTH_URL);
  const res = NextResponse.redirect(
    buildEndSessionUrl({
      issuer: env.KEYCLOAK_ISSUER,
      clientId: env.KEYCLOAK_CLIENT_ID,
      idToken: token?.idToken,
      postLogoutRedirectUri: `${new URL(env.NEXTAUTH_URL).origin}/login`,
    }),
    303,
  );
  for (const c of req.cookies.getAll())
    if (isSessionCookie(c.name, base)) res.cookies.delete(c.name);
  return res;
}
