import 'server-only';
import { cookies, headers } from 'next/headers';
import { getServerSession } from 'next-auth';
import { getToken } from 'next-auth/jwt';
import { buildAuthOptions } from './options';
import { authEnv } from './env';
import { needsRefresh } from './refresh';

export const getSession = () => getServerSession(buildAuthOptions());

/**
 * Access token for calling the API from Server Components / route handlers.
 * Returns null when signed out or when the access token is (nearly) expired: the proxy
 * refreshes before rendering, so this only happens if Keycloak was unavailable.
 */
export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;
  const token = await getToken({
    req: {
      headers: Object.fromEntries(await headers()),
      cookies: Object.fromEntries((await cookies()).getAll().map((c) => [c.name, c.value])),
    } as never, // next-auth v4 getToken wants a request-like object
    secret: authEnv().NEXTAUTH_SECRET,
  });
  if (!token?.accessToken || needsRefresh(token)) return null;
  return token.accessToken;
}
