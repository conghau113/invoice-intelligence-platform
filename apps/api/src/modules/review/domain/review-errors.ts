import type { ApiErrorCode } from 'contracts';

/** The body of an approval does not pass `InvoiceSchema`. */
export const INVOICE_INVALID = 'INVOICE_INVALID' satisfies ApiErrorCode;

/** The document has been reopened as often as `MAX_DOCUMENT_VERSION` allows. */
export const REOPEN_LIMIT_REACHED = 'REOPEN_LIMIT_REACHED' satisfies ApiErrorCode;

/** The document is ready for review but has no extraction to compare with: nothing to approve. */
export class ExtractionMissingError extends Error {
  readonly code = 'EXTRACTION_MISSING';

  constructor() {
    super('The document has no extraction');
    this.name = 'ExtractionMissingError';
  }
}
