import { z } from 'zod';
import { TAX_CODE } from './invoice';

// Q&A over approved invoices (T5.4, AI_PIPELINE.md §7). Two kinds of schema live here:
// - what the MODEL answers (QaRoute, QaAnswer): exported to JSON Schema, the AI service generates
//   pydantic models from it and hands the same schema to the provider as structured output. The API
//   validates the AI service's answer again with Zod: model output is untrusted (CLAUDE.md).
// - what the API streams to the web over SSE (`QA_STREAM_EVENTS`), parsed by the web (T5.5).
// Same conventions as invoice.ts: `null` with the key present, never an absent key.

export const QA_MAX_QUESTION_CHARS = 1000;
/** Longest answer text the model may write; the prompt asks for a few sentences. */
export const QA_MAX_ANSWER_CHARS = 4000;
/** Longest supplier or item text in a filter: longer is not a name, it is a sentence. */
const MAX_FILTER_TEXT = 200;
/** No invoice is older; Postgres also has no year 0, which `z.iso.date()` accepts. */
export const QA_MIN_ISSUE_DATE = '1900-01-01';

const NUL = '\u0000';

export const QaAskBodySchema = z.strictObject({
  // Postgres text cannot hold NUL: it would fail as a 500 in full-text search (security review).
  question: z
    .string()
    .trim()
    .min(1)
    .max(QA_MAX_QUESTION_CHARS)
    .refine((q) => !q.includes(NUL)),
});
export type QaAskBody = z.infer<typeof QaAskBodySchema>;

/** lookup → retrieval + cited answer; aggregate → structured filter + SQL; out_of_scope → refused. */
export const QA_INTENTS = ['lookup', 'aggregate', 'out_of_scope'] as const;

/**
 * What an aggregate adds up. `total`, `subtotal`, `vatAmount` are invoice columns (`current_invoices`);
 * `lineAmount` sums the amount (before VAT) of the lines whose description matches `itemDescription`
 * (`current_invoice_lines`); `invoiceCount` counts invoices.
 */
export const QA_METRICS = ['total', 'subtotal', 'vatAmount', 'lineAmount', 'invoiceCount'] as const;
export type QaMetric = (typeof QA_METRICS)[number];

/**
 * The structured filter the model writes instead of SQL. Every field is a value, never a column
 * name or an operator: the API owns the query and passes these as parameters.
 */
export const QaAggregateFilterSchema = z
  .strictObject({
    metric: z.enum(QA_METRICS),
    sellerName: z.string().min(1).max(MAX_FILTER_TEXT).nullable(),
    sellerTaxCode: z.string().regex(TAX_CODE).nullable(),
    issueDateFrom: z.iso.date().nullable(),
    issueDateTo: z.iso.date().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    itemDescription: z.string().min(1).max(MAX_FILTER_TEXT).nullable(),
  })
  .meta({ id: 'QaAggregateFilter' });
export type QaAggregateFilter = z.infer<typeof QaAggregateFilterSchema>;

/** Model output of the routing step. It sees the question only, never document content. */
export const QaRouteSchema = z
  .strictObject({
    intent: z.enum(QA_INTENTS),
    filter: QaAggregateFilterSchema.nullable(),
  })
  .meta({ id: 'QaRoute' });
export type QaRoute = z.infer<typeof QaRouteSchema>;

/**
 * Model output of the answer step. `answer` cites sources as `[n]`, n being the 1-based number of a
 * source in the request. No list of citations: they are read from the text, so the text cannot cite
 * something the list does not, or the reverse.
 */
export const QaAnswerSchema = z
  .strictObject({
    insufficientEvidence: z.boolean(),
    answer: z.string().max(QA_MAX_ANSWER_CHARS),
  })
  .meta({ id: 'QaAnswer' });
export type QaAnswer = z.infer<typeof QaAnswerSchema>;

/**
 * Why a filter the schema accepts still cannot run. Business rules, not shape: kept out of the
 * schema so the provider's structured output (which cannot express them) and Zod stay the same.
 */
export function aggregateFilterProblems(filter: QaAggregateFilter): string[] {
  const problems: string[] = [];
  for (const date of [filter.issueDateFrom, filter.issueDateTo]) {
    if (date !== null && date < QA_MIN_ISSUE_DATE) problems.push('date before 1900');
  }
  for (const text of [filter.sellerName, filter.itemDescription]) {
    if (text?.includes(NUL)) problems.push('NUL in a text');
  }
  if (filter.issueDateFrom && filter.issueDateTo && filter.issueDateFrom > filter.issueDateTo) {
    problems.push('issueDateFrom is after issueDateTo');
  }
  if (filter.metric === 'lineAmount' && filter.itemDescription === null) {
    problems.push('lineAmount needs itemDescription');
  }
  if (
    filter.itemDescription !== null &&
    filter.metric !== 'lineAmount' &&
    filter.metric !== 'invoiceCount'
  ) {
    // "Total of the invoices that contain item X" reads like "what did X cost": refuse the guess.
    problems.push('itemDescription only goes with lineAmount or invoiceCount');
  }
  return problems;
}

/** Why no answer was given. The web translates the reason (T5.5); it never carries content. */
export const QA_REFUSAL_REASONS = [
  'OUT_OF_SCOPE', // not a question about the tenant's invoices
  'INSUFFICIENT_EVIDENCE', // the retrieved invoices do not answer it
  'NO_MATCHING_INVOICES', // an aggregate matched no approved invoice
  'ANSWER_REJECTED', // the model's answer or filter failed the API's checks (citations, rules)
] as const;
export type QaRefusalReason = (typeof QA_REFUSAL_REASONS)[number];

/** Same shape as a chunk's refs (T5.1): what to open and which field to highlight. */
export const QaCitationRefSchema = z.strictObject({
  document_id: z.guid(),
  field_path: z.string().min(1),
  page: z.int().min(1).nullable(),
});

/**
 * One source of an answer. Lookup: a retrieved chunk (`chunkId`), `n` matching the `[n]` in the text.
 * Aggregate: an invoice that was added up (`chunkId` null), numbered in order.
 */
export const QaCitationSchema = z.strictObject({
  n: z.int().min(1),
  documentId: z.guid(),
  documentVersion: z.int().min(1),
  invoiceId: z.guid(),
  chunkId: z.guid().nullable(),
  refs: z.array(QaCitationRefSchema),
});
export type QaCitation = z.infer<typeof QaCitationSchema>;

export const QaAggregateResultSchema = z.strictObject({
  filter: QaAggregateFilterSchema,
  /** One sum per currency, in minor units; empty for `invoiceCount`. */
  results: z.array(
    z.strictObject({
      currency: z.string().regex(/^[A-Z]{3}$/),
      amount: z.int(),
    }),
  ),
  invoiceCount: z.int().min(1),
  /**
   * The suppliers whose invoices were added up (at most 20, by name), and how many there are: a
   * name filter is "contains", so "Garcia" may add up two suppliers, and the reader must see it.
   */
  sellers: z.array(z.strictObject({ name: z.string(), taxCode: z.string() })),
  sellerCount: z.int().min(1),
});
export type QaAggregateResult = z.infer<typeof QaAggregateResultSchema>;

/**
 * Events of `POST /qa/ask` (`text/event-stream`), in this order: either `token`… or `aggregate`,
 * then `citations`; or `refusal` alone; then `done`. The answer is checked in full before the first
 * event is written (T5.4), so nothing streamed is ever retracted.
 */
export const QA_STREAM_EVENTS = {
  token: z.strictObject({ text: z.string().min(1) }),
  aggregate: QaAggregateResultSchema,
  citations: z.strictObject({ citations: z.array(QaCitationSchema) }),
  refusal: z.strictObject({ reason: z.enum(QA_REFUSAL_REASONS) }),
  done: z.strictObject({}),
} as const;
export type QaStreamEventName = keyof typeof QA_STREAM_EVENTS;
export type QaStreamEvent = {
  [K in QaStreamEventName]: { event: K; data: z.infer<(typeof QA_STREAM_EVENTS)[K]> };
}[QaStreamEventName];

/** Both model outputs in one document, so Python gets one generated module (`qa_generated.py`). */
export const QaModelOutputsSchema = z.strictObject({
  route: QaRouteSchema,
  answer: QaAnswerSchema,
});
