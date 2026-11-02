import { InvoiceSchema } from 'contracts';
import { z } from 'zod';

/** Largest file the worker reads into memory: same cap as the upload (10 MB, T2.1). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** `usage` of AI_PIPELINE.md section 4: null on the XML path (no model involved). */
export const usageSchema = z.strictObject({
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  latencyMs: z.int().min(0),
  costUsd: z.number().min(0),
});
export type Usage = z.infer<typeof usageSchema>;

/**
 * What POST /extract may answer (API.md "Internal API"). The AI service is ours but its output is
 * still untrusted input here: the invoice goes through the same `InvoiceSchema` as everywhere
 * else. `warnings` is stored as-is and not interpreted until T3.3 defines the rules; the cap stops
 * a runaway list from filling the database. `.strict()` makes an extra field an error.
 */
export const aiExtractResponseSchema = z.strictObject({
  invoice: InvoiceSchema,
  warnings: z.array(z.unknown()).max(100),
  usage: usageSchema.nullable(),
});
export type AiExtractResponse = z.infer<typeof aiExtractResponseSchema>;

export const SOURCE_TYPES = ['xml', 'pdf', 'image'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const isSourceType = (v: unknown): v is SourceType =>
  typeof v === 'string' && (SOURCE_TYPES as readonly string[]).includes(v);
