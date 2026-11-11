import type { AiIndexResponse } from '../domain/ai-index-response';

export const AI_INDEXER = Symbol('AI_INDEXER');

/** One row of the view `current_invoices`, with the columns the AI service accepts (and no other). */
export type CurrentInvoiceRow = {
  id: string;
  tenant_id: string;
  document_id: string;
  document_version: number;
  data: unknown;
};

/**
 * POST /index of the AI service: chunks and their vectors. Throws `PermanentIndexError` when a
 * retry cannot help; any other error is treated as transient.
 */
export interface AiIndexer {
  index(row: CurrentInvoiceRow): Promise<AiIndexResponse>;
}
