import { z } from 'zod';

/** A share between 0 and 1. The page formats it; the API never sends a pre-formatted percentage. */
const rate = z.number().min(0).max(1);
const count = z.number().int().min(0);

/**
 * One field of the human correction rate. Line and VAT columns are grouped (`lines.*.amount`) and
 * counted once per document with at least one corrected cell: rows are matched by position, so
 * counting cells would let one deleted line inflate every line after it (T3.5).
 */
export const CorrectedFieldSchema = z.object({
  field: z.string().min(1),
  documents: count,
  rate,
});

/** What reviewers changed, from what is approved now (`current_field_corrections`, T3.8). */
export const OnlineInsightsSchema = z.object({
  /** Documents of the AI path (PDF, picture) whose current version is approved. The denominator. */
  approvedDocuments: count,
  /** Of those, approved without a single change. */
  uncorrectedDocuments: count,
  /** Approved XML documents, left out: the XML parser is deterministic, not the model. */
  excludedXmlDocuments: count,
  fields: z.array(CorrectedFieldSchema),
  /** Mean list-price estimate of the extraction calls (USD); the free tier bills 0. Null without data. */
  costUsdPerDocument: z.number().min(0).nullable(),
});

/** Aggregate numbers of the primary model's eval report (T4.4). Never document values. */
export const OfflineInsightsSchema = z.object({
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  dataset: z.string().min(1),
  /** Days the report was measured on (YYYY-MM-DD); latency on the free tier changes by day. */
  runDates: z.array(z.iso.date()).min(1),
  documents: count,
  fields: z.array(z.object({ field: z.string().min(1), accuracy: rate })),
  linesF1: rate,
  criticalExact: rate,
  documentExact: rate,
  costUsdPerDocument: z.number().min(0),
  latency: z.object({ p50Ms: count, p95Ms: count }),
});

/** `GET /insights/extraction` (API.md). `offline` is null when no eval report is available. */
export const ExtractionInsightsSchema = z.object({
  online: OnlineInsightsSchema,
  offline: OfflineInsightsSchema.nullable(),
});

export type CorrectedField = z.infer<typeof CorrectedFieldSchema>;
export type OnlineInsights = z.infer<typeof OnlineInsightsSchema>;
export type OfflineInsights = z.infer<typeof OfflineInsightsSchema>;
export type ExtractionInsights = z.infer<typeof ExtractionInsightsSchema>;
