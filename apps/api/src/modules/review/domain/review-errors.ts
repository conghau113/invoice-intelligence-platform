/** The body of an approval does not pass `InvoiceSchema`. */
export const INVOICE_INVALID = 'INVOICE_INVALID';

/** The document is ready for review but has no extraction to compare with: nothing to approve. */
export class ExtractionMissingError extends Error {
  readonly code = 'EXTRACTION_MISSING';

  constructor() {
    super('The document has no extraction');
    this.name = 'ExtractionMissingError';
  }
}
