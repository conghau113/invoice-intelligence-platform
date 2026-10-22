export type UploadErrorKey =
  | 'unsupportedType'
  | 'tooLarge'
  | 'empty'
  | 'sessionExpired'
  | 'forbidden'
  | 'tenant'
  | 'idempotency'
  | 'queueUnavailable'
  | 'network'
  | 'server'
  | 'unknown';

/** What went wrong with one request: the HTTP status (absent on network failure) and API `code`. */
export interface UploadFailure {
  status?: number;
  code?: string;
}

const BY_CODE: Readonly<Record<string, UploadErrorKey>> = {
  UNSUPPORTED_FILE_TYPE: 'unsupportedType',
  IDEMPOTENCY_KEY_REQUIRED: 'idempotency',
  IDEMPOTENCY_KEY_REUSED: 'idempotency',
  QUEUE_UNAVAILABLE: 'queueUnavailable',
  FORBIDDEN_PERMISSION: 'forbidden',
  TENANT_REQUIRED: 'tenant',
  TENANT_NOT_MEMBER: 'tenant',
};

/** Maps a failure to a key under `Upload.errors.*` (messages/{vi,en}.json). Never shows raw server text. */
export function errorKeyFor({ status, code }: UploadFailure): UploadErrorKey {
  if (code !== undefined && code in BY_CODE) return BY_CODE[code]!;
  if (status === undefined) return 'network';
  if (status === 413) return 'tooLarge';
  if (status === 415) return 'unsupportedType';
  if (status === 401) return 'sessionExpired';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * Failures a second attempt cannot fix: the same bytes would be refused again, the same key
 * would be refused again (idempotency), or the user must sign in first (sessionExpired).
 */
export const isRetryable = (key: UploadErrorKey): boolean =>
  ![
    'unsupportedType',
    'tooLarge',
    'empty',
    'forbidden',
    'tenant',
    'idempotency',
    'sessionExpired',
  ].includes(key);
