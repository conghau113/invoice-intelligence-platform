import path from 'node:path';
import { z } from 'zod';
import { trustedProxiesProblem } from './trusted-proxies';

// z.coerce.boolean() would turn the string "false" into true, so booleans are parsed explicitly.
const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

/** `https://host[:port]` with no path, query or trailing slash: what a browser sends as Origin. */
function isBareOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

const envFields = z.object({
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
  // Committed eval reports (eval/reports) behind /insights (T4.6). Optional: without it the page
  // shows the human correction rate only. Absolute for the same reason as DATA_DIR; empty = not set.
  EVAL_REPORTS_DIR: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .refine((v) => path.isAbsolute(v), 'must be an absolute path')
      .optional(),
  ),
  // Redis for BullMQ (ADR 0008). The API and the worker process both read it.
  REDIS_URL: z.url(),
  // Read cache (lists, dashboard) and extraction result cache in Redis (ADR 0013, T6.3). `false`
  // sends every read to Postgres and every PDF/image to the AI service: for before/after measurements.
  CACHE_ENABLED: booleanString.default(true),
  // First wait of the retry backoff; tests set a few ms, production keeps seconds.
  QUEUE_BACKOFF_BASE_MS: z.coerce.number().int().min(1).max(60_000).default(5_000),
  // Internal AI service (ADR 0002): base URL and the shared bearer token the worker sends (API.md).
  AI_SERVICE_URL: z.url(),
  AI_SERVICE_TOKEN: z.string().min(16),
  // How long the worker waits for /extract on the PDF/image (LLM) path; XML has its own short limit.
  // Keep it above the AI service's own 55 s budget so the service can answer with its error code.
  AI_LLM_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(60_000),
  // What the LLM provider plan allows (AI_PIPELINE.md §8, T6.2). Limits vary by account and change:
  // take them from the provider's rate-limit page (AI Studio for Gemini). The extraction queue is
  // paced to stay under both; a 429 still holds the queue for the wait the provider names.
  LLM_RPM: z.coerce.number().int().min(1).max(100_000).default(10),
  LLM_TPM: z.coerce.number().int().min(1).max(100_000_000).default(100_000),
  // The same for the embedding model behind indexing (its own quota; 30K TPM on Gemini free, T5.3).
  EMBED_RPM: z.coerce.number().int().min(1).max(100_000).default(60),
  EMBED_TPM: z.coerce.number().int().min(1).max(100_000_000).default(30_000),
  // Length of the provider's "minute": 60 000. Tests shrink it to run the pacing in seconds.
  PROVIDER_MINUTE_MS: z.coerce.number().int().min(100).max(60_000).default(60_000),
  // Circuit breaker of the queues: failures in a row that stop them, and the first pause.
  BREAKER_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  BREAKER_COOLDOWN_MS: z.coerce.number().int().min(100).max(600_000).default(60_000),
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
  // Hybrid retrieval (T5.3): chunks returned after fusion, and candidates read from EACH of the vector
  // and full-text lists before fusing them (RRF only reorders what the two lists bring).
  RAG_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  RAG_CANDIDATES: z.coerce.number().int().min(5).max(100).default(20),
  // Realtime gateway (T6.4, ADR 0014). The key that signs the short-lived handshake tokens: the same
  // value on every API instance, at least 32 characters. Not set (or empty) = realtime is off: no
  // token is issued, every handshake is refused, and the web keeps polling (the public demo).
  REALTIME_TOKEN_SECRET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32).optional(),
  ),
  // Browser origins allowed to open a socket (comma-separated). The web's own origin; never `*`.
  // Defaults to the local web outside production; required in production when realtime is on.
  REALTIME_ALLOWED_ORIGINS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .transform((v) => v.split(',').map((o) => o.trim()))
      .pipe(z.array(z.url().refine(isBareOrigin, 'must be a bare origin')).min(1))
      .optional(),
  ),
  // A socket is closed after this long (plus up to 10% jitter) so the client reconnects with a new
  // token: a user signed out or removed from the tenant loses the stream within this time.
  REALTIME_MAX_CONNECTION_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(900_000),
});

/** The web of `pnpm --filter web dev`; never assumed in production. */
const DEV_WEB_ORIGIN = 'http://localhost:3000';

// Cross-field rules, apart from the fields so that each field keeps its own error message.
export const envSchema = envFields
  .refine((env) => env.RAG_CANDIDATES >= env.RAG_TOP_K, {
    message: 'must be at least RAG_TOP_K',
    path: ['RAG_CANDIDATES'],
  })
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      env.REALTIME_TOKEN_SECRET === undefined ||
      env.REALTIME_ALLOWED_ORIGINS !== undefined,
    {
      message: 'required in production when REALTIME_TOKEN_SECRET is set',
      path: ['REALTIME_ALLOWED_ORIGINS'],
    },
  )
  .transform((env) => ({
    ...env,
    REALTIME_ALLOWED_ORIGINS: env.REALTIME_ALLOWED_ORIGINS ?? [DEV_WEB_ORIGIN],
  }));

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
