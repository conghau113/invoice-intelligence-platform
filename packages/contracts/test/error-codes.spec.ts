import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_ERROR_CODES,
  BFF_ERROR_CODES,
  DOCUMENT_FAILURE_CODES,
  HTTP_ERROR_CODES,
  isApiErrorCode,
  isDocumentFailureCode,
  isHttpErrorCode,
} from '../src';

describe('error codes', () => {
  it('the fixture the Python service is tested against is this same list', () => {
    const fixture: unknown = JSON.parse(
      readFileSync(join(__dirname, '..', 'fixtures', 'failure-codes.json'), 'utf8'),
    );
    expect(fixture).toEqual([...DOCUMENT_FAILURE_CODES].sort());
  });

  it.each([
    ['document failures', DOCUMENT_FAILURE_CODES],
    ['API errors', API_ERROR_CODES],
    ['BFF errors', BFF_ERROR_CODES],
  ])('%s are upper snake case and listed once', (_name, codes) => {
    for (const code of codes) expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,63}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('an API code and a BFF code never share a name: the web could not tell who sent it', () => {
    expect(
      API_ERROR_CODES.filter((c) => (BFF_ERROR_CODES as readonly string[]).includes(c)),
    ).toEqual([]);
    expect(HTTP_ERROR_CODES).toHaveLength(API_ERROR_CODES.length + BFF_ERROR_CODES.length);
  });

  it.each([
    ['isDocumentFailureCode', isDocumentFailureCode, 'LLM_RATE_LIMITED', 'FORBIDDEN_PERMISSION'],
    ['isApiErrorCode', isApiErrorCode, 'VERSION_CONFLICT', 'API_UNREACHABLE'],
    ['isHttpErrorCode', isHttpErrorCode, 'API_UNREACHABLE', 'LLM_RATE_LIMITED'],
  ])('%s accepts its own list and nothing else', (_name, guard, listed, other) => {
    expect(guard(listed)).toBe(true);
    for (const value of [other, 'SOMETHING_NEW', 'toString', '', null, undefined, 1, {}]) {
      expect(guard(value)).toBe(false);
    }
  });
});
