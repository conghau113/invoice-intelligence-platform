import { z } from 'zod';

// z.coerce.boolean() would turn the string "false" into true, so booleans are parsed explicitly.
const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DEMO_READ_ONLY: booleanString.default(false),
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
