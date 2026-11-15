import { extractionKey, extractionLockKey, generationKey, readKey } from './cache-keys';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const HASH = 'a'.repeat(64);
const VERSION = {
  model: 'gemini-3.5-flash-lite',
  promptVersion: 'invoice_extraction/v1',
  pipelineVersion: 'b'.repeat(64),
};

describe('cache keys', () => {
  it('starts every key with the tenant inside a hash tag', () => {
    expect(generationKey(ACME)).toBe(`cache:{${ACME}}:gen`);
    expect(readKey(ACME, 3, 'documents-list', { page: 1 })).toMatch(
      new RegExp(`^cache:\\{${ACME}\\}:g3:`),
    );
    expect(extractionKey(ACME, HASH, VERSION)).toMatch(new RegExp(`^cache:\\{${ACME}\\}:extract:`));
  });

  it('two tenants never share a key for the same query, generation or file', () => {
    expect(readKey(ACME, 1, 'documents-list', { page: 1 })).not.toBe(
      readKey(GLOBEX, 1, 'documents-list', { page: 1 }),
    );
    expect(extractionKey(ACME, HASH, VERSION)).not.toBe(extractionKey(GLOBEX, HASH, VERSION));
  });

  it('the same query in another field order is the same key; an absent field is left out', () => {
    expect(readKey(ACME, 1, 'documents-list', { page: 2, limit: 20, status: undefined })).toBe(
      readKey(ACME, 1, 'documents-list', { limit: 20, page: 2 }),
    );
  });

  it('every field and the generation are part of the key', () => {
    const base = readKey(ACME, 1, 'documents-list', { page: 1, limit: 20 });
    expect(readKey(ACME, 2, 'documents-list', { page: 1, limit: 20 })).not.toBe(base);
    expect(readKey(ACME, 1, 'documents-list', { page: 2, limit: 20 })).not.toBe(base);
    expect(readKey(ACME, 1, 'documents-list', { page: 1, limit: 50 })).not.toBe(base);
    expect(readKey(ACME, 1, 'insights-online', { page: 1, limit: 20 })).not.toBe(base);
  });

  it('a value cannot forge a separator', () => {
    const forged = readKey(ACME, 1, 'documents-list', { status: 'x&page=9' });
    expect(forged).not.toContain('&page=9');
  });

  it.each(['acme', '', `{${GLOBEX}}`, `${ACME}}:x`])(
    'refuses a tenant that is not a uuid (%j)',
    (bad) => {
      expect(() => generationKey(bad)).toThrow('Invalid tenant id');
      expect(() => extractionKey(bad, HASH, VERSION)).toThrow('Invalid tenant id');
    },
  );

  it('every part of the extraction key changes it', () => {
    const base = extractionKey(ACME, HASH, VERSION);
    expect(extractionKey(ACME, 'c'.repeat(64), VERSION)).not.toBe(base);
    expect(extractionKey(ACME, HASH, { ...VERSION, model: 'other' })).not.toBe(base);
    expect(
      extractionKey(ACME, HASH, { ...VERSION, promptVersion: 'invoice_extraction/v2' }),
    ).not.toBe(base);
    expect(extractionKey(ACME, HASH, { ...VERSION, pipelineVersion: 'c'.repeat(64) })).not.toBe(
      base,
    );
    expect(extractionLockKey(base)).toBe(`${base}:lock`);
  });

  it.each([
    ['a hash that is not sha256', 'xyz', VERSION, 'Invalid content hash'],
    ['a model with a colon', HASH, { ...VERSION, model: 'a:b' }, 'Invalid extraction version'],
    [
      'an empty pipeline version',
      HASH,
      { ...VERSION, pipelineVersion: '' },
      'Invalid extraction version',
    ],
    [
      'a prompt version with a space',
      HASH,
      { ...VERSION, promptVersion: 'v 1' },
      'Invalid extraction version',
    ],
  ])('refuses %s', (_label, hash, version, message) => {
    expect(() => extractionKey(ACME, hash, version)).toThrow(message);
  });

  it('refuses a generation that is not a whole number', () => {
    expect(() => readKey(ACME, -1, 'documents-list')).toThrow('Invalid generation');
    expect(() => readKey(ACME, 1.5, 'documents-list')).toThrow('Invalid generation');
  });
});
