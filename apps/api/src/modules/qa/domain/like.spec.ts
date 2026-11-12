import { containsPattern } from './like';

describe('containsPattern', () => {
  it('wraps the text in % and escapes the LIKE wildcards and the escape character', () => {
    expect(containsPattern('SAMPLE')).toBe('%SAMPLE%');
    expect(containsPattern('100%_a\\b')).toBe('%100\\%\\_a\\\\b%');
  });
});
