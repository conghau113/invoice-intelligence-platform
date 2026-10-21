import path from 'node:path';
import { z } from 'zod';

// z.coerce.boolean() would turn the string "false" into true, so booleans are parsed explicitly.
const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DEMO_READ_ONLY: booleanString.default(false),
  // Exact `iss` the API accepts. Explicit because Keycloak derives it from the request host.
  OIDC_ISSUER_URL: z.url(),
  // Defaults to <issuer>/protocol/openid-connect/certs; set when the API reaches Keycloak by another host.
  OIDC_JWKS_URL: z.url().optional(),
  // Connection of the NON-owner role `invoice_app` (RLS applies to it). The owner URL used by
  // migrations is read only by the db scripts, never by the API process.
  DATABASE_URL: z.url(),
  // Where StoragePort(LocalFs) keeps uploaded files. Absolute on purpose: a relative path would depend
  // on the working directory and could land inside the repo, where .gitignore does not cover it.
  DATA_DIR: z.string().refine((v) => path.isAbsolute(v), 'must be an absolute path'),
  // Redis for BullMQ (ADR 0008). The API and the worker process both read it.
  REDIS_URL: z.url(),
  // First wait of the retry backoff; tests set a few ms, production keeps seconds.
  QUEUE_BACKOFF_BASE_MS: z.coerce.number().int().min(1).max(60_000).default(5_000),
  OIDC_AUDIENCE: z.string().min(1).default('api'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates raw process env at startup. Throws listing every offending variable NAME and the
 * reason, never the value (values may be secrets).
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => `- ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
}
