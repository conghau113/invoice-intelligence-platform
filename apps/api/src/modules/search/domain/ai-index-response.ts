import { z } from 'zod';
import { EMBEDDING_DIMENSIONS } from '../../../db/schema';

/**
 * What the AI service answers on POST /index (API.md). Checked before anything is written: the
 * vectors go straight into `vector(768)`, and the ids are compared with the job (index.processor).
 */
const chunkRefSchema = z.strictObject({
  document_id: z.uuid(),
  field_path: z.string().min(1).max(200),
  page: z.number().int().min(1).nullable(),
});
/** Where a chunk's text comes from: what a citation opens (T5.4, T5.5). */
export type ChunkRef = z.infer<typeof chunkRefSchema>;

const chunkSchema = z.strictObject({
  tenant_id: z.uuid(),
  document_id: z.uuid(),
  document_version: z.number().int().min(1),
  invoice_id: z.uuid(),
  kind: z.enum(['header', 'lines']),
  ordinal: z.number().int().min(0),
  content: z.string().min(1),
  refs: z.array(chunkRefSchema),
});

export const aiIndexResponseSchema = z.strictObject({
  model: z.string().min(1).max(100),
  chunks: z
    .array(
      z.strictObject({
        chunk: chunkSchema,
        // z.number() refuses NaN and Infinity, which would poison every distance.
        embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
      }),
    )
    .min(1),
});
export type AiIndexResponse = z.infer<typeof aiIndexResponseSchema>;
