import { isDocumentFailureCode, type DocumentFailureCode } from 'contracts';

/** Failure codes the worker records. Codes only, never a message: a message may hold document content. */
export const EXTRACTION_SCHEMA_INVALID = 'EXTRACTION_SCHEMA_INVALID' satisfies DocumentFailureCode;
export const FILE_MISSING = 'FILE_MISSING' satisfies DocumentFailureCode;
export const FILE_TOO_LARGE = 'FILE_TOO_LARGE' satisfies DocumentFailureCode;

/**
 * Error taxonomy of the AI service's answer (`HttpAiExtractor.extract`), the one place to read it:
 *  - transient, BullMQ retries (5 attempts, backoff): network error or timeout, 5xx except 501
 *    (LLM_UNAVAILABLE, LLM_TIMEOUT_OR_NETWORK, LLM_MISCONFIGURED, LLM_NOT_CONFIGURED,
 *    LLM_BAD_RESPONSE), 408, 429 (LLM_RATE_LIMITED), and 401/403/404 (our own settings, see below).
 *    When the attempts run out the document fails with the service's code, else a generic one.
 *  - permanent, `failed` at once: any other 4xx (PDF_INVALID, PDF_TOO_MANY_PAGES, PDF_TOO_LARGE,
 *    IMAGE_UNSUPPORTED, IMAGE_INVALID, LLM_REQUEST_REJECTED, LLM_NO_CANDIDATE, XML_*,
 *    FILE_TOO_LARGE), 501, and a 200 whose body is not a valid invoice (EXTRACTION_SCHEMA_INVALID).
 * Why: retrying a permanent error wastes 5 paid calls to get the same answer; failing a transient
 * one at once loses a document that the next attempt would have read.
 */

/**
 * The AI service's reason is kept only if it is on the list the web can translate. Any other value
 * becomes the generic code: the document still fails, and a response body cannot choose what is stored.
 */
export const isFailureCode = isDocumentFailureCode;

/**
 * The AI service answered 401/403/404: our own settings (token, URL) are wrong, not the document.
 * Treated as transient on purpose: a token rotated or a deploy half done is usually fixed within
 * the retry window, and when it is not, the document fails with this code (not a file error) so
 * an administrator knows to fix the configuration and retry. Circuit-breaking the queue is T6.7.
 */
export const AI_SERVICE_MISCONFIGURED = 'AI_SERVICE_MISCONFIGURED' satisfies DocumentFailureCode;

/** The stored extraction no longer matches `InvoiceSchema` (a bug or manual edit); reads fail loudly. */
export class ExtractionDataInvalidError extends Error {
  readonly code = 'EXTRACTION_DATA_INVALID';

  constructor() {
    super('Stored extraction is invalid');
    this.name = 'ExtractionDataInvalidError';
  }
}
