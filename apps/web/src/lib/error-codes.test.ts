import { DOCUMENT_FAILURE_CODES, HTTP_ERROR_CODES } from 'contracts';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import vi from '../../messages/vi.json';

const LOCALES = [
  ['en', en],
  ['vi', vi],
] as const;

/** Every code that can reach the screen has a real message, and every message still has a code. */
describe.each(LOCALES)('error messages in %s', (_locale, messages) => {
  it('has one message per HTTP error code, and none for a code that is gone', () => {
    const shown: Readonly<Record<string, string>> = messages.ApiError;
    for (const code of HTTP_ERROR_CODES) expect(shown[code]?.trim(), code).toBeTruthy();
    expect(Object.keys(shown).sort()).toEqual([...HTTP_ERROR_CODES].sort());
  });

  it('has one message per document failure code, plus the fallback for anything else', () => {
    const shown: Readonly<Record<string, string>> = messages.DocumentDetail.failure;
    for (const code of DOCUMENT_FAILURE_CODES) expect(shown[code]?.trim(), code).toBeTruthy();
    expect(shown.unknown?.trim()).toBeTruthy();
    expect(Object.keys(shown).sort()).toEqual([...DOCUMENT_FAILURE_CODES, 'unknown'].sort());
  });
});
