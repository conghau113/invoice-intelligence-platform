import path from 'node:path';
import { z } from 'zod';
import { trustedProxiesProblem } from './trusted-proxies';

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
  // Internal AI service (ADR 0002): base URL and the shared bearer token the worker sends (API.md).
  AI_SERVICE_URL: z.url(),
  AI_SERVICE_TOKEN: z.string().min(16),
  // How long the worker waits for /extract on the PDF/image (LLM) path; XML has its own short limit.
  // Keep it above the AI service's own 55 s budget so the service can answer with its error code.
  AI_LLM_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(60_000),
  // Peers whose X-Forwarded-For the API believes, so audit rows get the caller's address instead of
  // the web server's. Default: only a proxy on the same machine (dev, CI). In deployment set the
  // reverse proxy's address or network (M4). Never a value that trusts everyone (see trusted-proxies.ts).
  // An empty value (a copied `TRUSTED_PROXIES=` line) counts as not set: the default applies.
  TRUSTED_PROXIES: z
    .preprocess((v) => (v === '' ? undefined : v), z.string().default('loopback'))
    .superRefine((value, ctx) => {
      const problem = trustedProxiesProblem(value);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
    }),
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
