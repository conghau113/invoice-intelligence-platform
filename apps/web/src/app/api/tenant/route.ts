import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { authEnv } from '@/auth/env';
import { safeAlias, safePath } from '@/auth/login-params';
import { isSameOrigin } from '@/auth/logout';
import { TENANT_COOKIE } from '@/auth/tenant';

const ONE_YEAR = 365 * 24 * 60 * 60;

/** Remember which of the user's tenants the UI works in. The API still checks it on every call. */
export async function POST(req: NextRequest) {
  const env = authEnv();
  if (!isSameOrigin(req.headers.get('origin'), env.NEXTAUTH_URL)) {
    return NextResponse.json({ code: 'FORBIDDEN' }, { status: 403 });
  }
  const token = await getToken({ req, secret: env.NEXTAUTH_SECRET });
  const form = await req.formData();
  const rawTenant = form.get('tenant');
  const rawReturn = form.get('returnTo');
  const tenant = safeAlias(typeof rawTenant === 'string' ? rawTenant : undefined);
  // Only tenants listed in the user's own signed token can be chosen.
  if (!token || tenant === undefined || !token.tenants?.includes(tenant)) {
    return NextResponse.json({ code: 'FORBIDDEN' }, { status: 403 });
  }
  const res = NextResponse.redirect(
    new URL(safePath(typeof rawReturn === 'string' ? rawReturn : undefined), env.NEXTAUTH_URL),
    303,
  );
  res.cookies.set(TENANT_COOKIE, tenant, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NEXTAUTH_URL.startsWith('https://'),
    path: '/',
    maxAge: ONE_YEAR,
  });
  return res;
}
