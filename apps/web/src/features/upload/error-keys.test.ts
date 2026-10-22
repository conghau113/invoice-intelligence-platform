import { describe, expect, it } from 'vitest';
import { errorKeyFor, isRetryable } from './error-keys';
import en from '../../../messages/en.json';
import vi from '../../../messages/vi.json';

describe('errorKeyFor', () => {
  it.each([
    [{ status: 415, code: 'UNSUPPORTED_FILE_TYPE' }, 'unsupportedType'],
    [{ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }, 'idempotency'],
    [{ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' }, 'idempotency'],
    [{ status: 503, code: 'QUEUE_UNAVAILABLE' }, 'queueUnavailable'],
    [{ status: 403, code: 'FORBIDDEN_PERMISSION' }, 'forbidden'],
    [{ status: 403, code: 'TENANT_REQUIRED' }, 'tenant'],
    [{ status: 403, code: 'TENANT_NOT_MEMBER' }, 'tenant'],
    [{ status: 413 }, 'tooLarge'],
    [{ status: 401 }, 'sessionExpired'],
    [{ status: 502 }, 'server'],
    [{ status: 418 }, 'unknown'],
    [{}, 'network'],
    [{ status: 500, code: 'SOMETHING_NEW' }, 'server'],
  ] as const)('%j -> %s', (failure, key) => expect(errorKeyFor(failure)).toBe(key));

  it('every key it can return has a message in both languages', () => {
    const keys = [
      'unsupportedType',
      'tooLarge',
      'empty',
      'sessionExpired',
      'forbidden',
      'tenant',
      'idempotency',
      'queueUnavailable',
      'network',
      'server',
      'unknown',
    ] as const;
    for (const k of keys) {
      expect(en.Upload.errors[k]).toBeTruthy();
      expect(vi.Upload.errors[k]).toBeTruthy();
    }
  });

  it('only offers retry for failures a second attempt could fix', () => {
    expect(isRetryable('network')).toBe(true);
    expect(isRetryable('queueUnavailable')).toBe(true);
    expect(isRetryable('unsupportedType')).toBe(false);
    expect(isRetryable('forbidden')).toBe(false);
    expect(isRetryable('idempotency')).toBe(false);
    expect(isRetryable('sessionExpired')).toBe(false);
  });
});
