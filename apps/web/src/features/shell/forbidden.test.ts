import { describe, expect, it } from 'vitest';
import { forbiddenHintKey } from './forbidden';

describe('forbiddenHintKey', () => {
  it('maps the tenant codes to their own text', () => {
    expect(forbiddenHintKey('TENANT_REQUIRED')).toBe('forbiddenRequired');
    expect(forbiddenHintKey('TENANT_NOT_MEMBER')).toBe('forbiddenNotMember');
  });
  it.each([undefined, '', 'FORBIDDEN_PERMISSION', '__proto__', 'toString'])(
    'falls back to the generic text for %j',
    (code) => expect(forbiddenHintKey(code)).toBe('forbiddenHint'),
  );
});
