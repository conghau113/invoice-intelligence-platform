import NextAuth from 'next-auth';
import { buildAuthOptions } from '@/auth/options';

const handler = (req: Request, ctx: unknown) =>
  // Options built per request so env is read lazily (see auth/env.ts).
  (NextAuth(buildAuthOptions()) as unknown as (r: Request, c: unknown) => Promise<Response>)(
    req,
    ctx,
  ); // v4 App Router handler signature

export { handler as GET, handler as POST };
