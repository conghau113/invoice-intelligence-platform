import { z } from 'zod';

const schema = z.object({
  NEXTAUTH_URL: z.url(),
  NEXTAUTH_SECRET: z.string().min(32),
  KEYCLOAK_ISSUER: z.url(),
  KEYCLOAK_CLIENT_ID: z.string().min(1),
  KEYCLOAK_CLIENT_SECRET: z.string().min(1),
});

export type AuthEnv = z.infer<typeof schema>;

/** Read lazily (not at import) so `next build` in CI does not need secrets. */
export function authEnv(source: Record<string, string | undefined> = process.env): AuthEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Names only: never echo values (they include secrets).
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new Error(`Invalid auth environment: ${names}`);
  }
  return parsed.data;
}
