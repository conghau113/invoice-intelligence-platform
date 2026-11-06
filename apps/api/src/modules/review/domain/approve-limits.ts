import type { Invoice } from 'contracts';

/**
 * Limits for what a person may approve. They live here, not in `InvoiceSchema`, because that schema
 * is also the LLM's response schema and Gemini rejects one with `maxItems` (Phát sinh T3.1). Each
 * line adds rows to several tables inside one transaction that holds the document's row lock.
 */
export const MAX_APPROVED_LINES = 500;
export const MAX_APPROVED_VAT_ROWS = 20;
export const MAX_APPROVED_TEXT = 1000;
/**
 * Reopening keeps what was approved and the app role cannot delete it, so without a cap one account
 * could loop reopen and approve and fill the shared database. Far above any real correction.
 */
export const MAX_DOCUMENT_VERSION = 20;

/** Postgres `text` and `jsonb` refuse NUL: without this check it would be a 500 from client input. */
const acceptable = (text: string): boolean =>
  text.length <= MAX_APPROVED_TEXT && !text.includes('\u0000');

export function withinApproveLimits(invoice: Invoice): boolean {
  if (invoice.lines.length > MAX_APPROVED_LINES) return false;
  if (invoice.vatBreakdown.length > MAX_APPROVED_VAT_ROWS) return false;
  return [
    invoice.seller.name,
    invoice.seller.taxCode,
    invoice.seller.address,
    invoice.buyer.name,
    invoice.buyer.taxCode ?? '',
    invoice.buyer.address,
    invoice.invoiceNo,
    invoice.series,
    ...invoice.lines.flatMap((line) => [line.description, line.unit]),
  ].every(acceptable);
}
