/** Failure codes the worker records. Codes only, never a message: a message may hold document content. */
export const EXTRACTION_SCHEMA_INVALID = 'EXTRACTION_SCHEMA_INVALID';
export const FILE_MISSING = 'FILE_MISSING';
export const FILE_TOO_LARGE = 'FILE_TOO_LARGE';

/** Same shape the state machine accepts for a reason code. */
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const isFailureCode = (v: unknown): v is string => typeof v === 'string' && CODE.test(v);

/**
 * The AI service answered 401/403/404: our own settings (token, URL) are wrong, not the document.
 * Treated as transient on purpose: a token rotated or a deploy half done is usually fixed within
 * the retry window, and when it is not, the document fails with this code (not a file error) so
 * an administrator knows to fix the configuration and retry. Circuit-breaking the queue is T6.7.
 */
export const AI_SERVICE_MISCONFIGURED = 'AI_SERVICE_MISCONFIGURED';

/** The stored extraction no longer matches `InvoiceSchema` (a bug or manual edit); reads fail loudly. */
export class ExtractionDataInvalidError extends Error {
  readonly code = 'EXTRACTION_DATA_INVALID';

  constructor() {
    super('Stored extraction is invalid');
    this.name = 'ExtractionDataInvalidError';
  }
}
