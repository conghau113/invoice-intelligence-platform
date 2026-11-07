/**
 * The one list of error codes that cross a boundary between our services. A code is stable and holds
 * no document content, so it is safe to store, log and translate. The web has a message for every
 * code here, in both languages (`apps/web/src/lib/error-codes.test.ts` fails otherwise).
 *
 * To add a code: add it here, add its message to `apps/web/messages/{vi,en}.json`, and for a document
 * failure also to `fixtures/failure-codes.json`, which the Python service is tested against.
 */

/**
 * Why a document ended `failed`: the value of `documents.failure_code`. Set by the worker, or passed
 * on from the AI service. Codes stay here after nothing produces them, because old rows still hold
 * them (`EXTRACTION_PATH_NOT_IMPLEMENTED`, from before the LLM path existed).
 */
export const DOCUMENT_FAILURE_CODES = [
  'EXTRACTION_RETRIES_EXHAUSTED',
  'EXTRACTION_STALLED',
  'EXTRACTION_FAILED',
  'EXTRACTION_SCHEMA_INVALID',
  'EXTRACTION_PATH_NOT_IMPLEMENTED',
  'AI_SERVICE_MISCONFIGURED',
  'LLM_UNAVAILABLE',
  'LLM_RATE_LIMITED',
  'LLM_TIMEOUT_OR_NETWORK',
  'LLM_BAD_RESPONSE',
  'LLM_MISCONFIGURED',
  'LLM_NOT_CONFIGURED',
  'LLM_REQUEST_REJECTED',
  'LLM_NO_CANDIDATE',
  'PDF_INVALID',
  'PDF_TOO_MANY_PAGES',
  'PDF_TOO_LARGE',
  'IMAGE_UNSUPPORTED',
  'IMAGE_INVALID',
  'FILE_MISSING',
  'FILE_TOO_LARGE',
  'XML_MALFORMED',
  'XML_FORBIDDEN_CONSTRUCT',
  'XML_TOO_COMPLEX',
  'XML_UNSUPPORTED_STRUCTURE',
  'XML_MISSING_FIELD',
  'XML_INVALID_VALUE',
  'XML_UNSUPPORTED_CURRENCY',
  'XML_UNSUPPORTED_VAT_RATE',
] as const;
export type DocumentFailureCode = (typeof DOCUMENT_FAILURE_CODES)[number];

/** The `code` of a Problem Details response from `apps/api`. Anything else is not sent to a client. */
export const API_ERROR_CODES = [
  'FORBIDDEN_PERMISSION',
  'FORBIDDEN_UNDECLARED',
  'TENANT_REQUIRED',
  'TENANT_NOT_MEMBER',
  'UNSUPPORTED_FILE_TYPE',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'QUEUE_UNAVAILABLE',
  'INVALID_DOCUMENT_TRANSITION',
  'VERSION_CONFLICT',
  'JOB_NOT_FAILED',
  'IF_MATCH_REQUIRED',
  'INVOICE_INVALID',
  'REOPEN_LIMIT_REACHED',
  'EXTRACTION_MISSING',
  'EXTRACTION_DATA_INVALID',
  'INVALID_QUERY',
  'BODY_TOO_LARGE',
  'BODY_INVALID',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** The `code` the web's own route handlers answer with, before or instead of calling the API. */
export const BFF_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'BAD_REQUEST',
  'TOO_LARGE',
  'API_UNREACHABLE',
  'API_ERROR',
  'UPSTREAM_UNAVAILABLE',
] as const;
export type BffErrorCode = (typeof BFF_ERROR_CODES)[number];

/** Every `code` a browser can read from a failed request. */
export const HTTP_ERROR_CODES = [...API_ERROR_CODES, ...BFF_ERROR_CODES] as const;
export type HttpErrorCode = ApiErrorCode | BffErrorCode;

const has = (list: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && list.includes(value);

export const isDocumentFailureCode = (value: unknown): value is DocumentFailureCode =>
  has(DOCUMENT_FAILURE_CODES, value);

export const isApiErrorCode = (value: unknown): value is ApiErrorCode =>
  has(API_ERROR_CODES, value);

export const isHttpErrorCode = (value: unknown): value is HttpErrorCode =>
  has(HTTP_ERROR_CODES, value);
