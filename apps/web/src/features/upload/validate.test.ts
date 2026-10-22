import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, validateFile } from './validate';

const f = (name: string, size = 10, type = '') => ({ name, size, type });

describe('validateFile', () => {
  it.each([
    ['a.pdf', 'application/pdf'],
    ['a.PNG', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', ''],
    ['a.xml', 'text/xml'],
    ['a.xml', 'application/xml'],
  ])('accepts %s (%s)', (name, type) => expect(validateFile(f(name, 10, type))).toBeNull());

  it.each([
    ['no extension', f('invoice')],
    ['executable', f('a.exe')],
    ['double extension', f('a.pdf.exe')],
    ['name says pdf, declared type says html', f('a.pdf', 10, 'text/html')],
    ['trailing dot', f('a.')],
  ])('rejects %s as unsupportedType', (_label, file) =>
    expect(validateFile(file)).toBe('unsupportedType'),
  );

  it('rejects empty and oversized files, and accepts exactly the limit', () => {
    expect(validateFile(f('a.pdf', 0))).toBe('empty');
    expect(validateFile(f('a.pdf', MAX_UPLOAD_BYTES + 1))).toBe('tooLarge');
    expect(validateFile(f('a.pdf', MAX_UPLOAD_BYTES))).toBeNull();
  });
});
