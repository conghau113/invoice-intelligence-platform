import { describe, expect, it } from 'vitest';
import { initialsOf } from './user-display';

describe('initialsOf', () => {
  it('takes the first and last word', () => {
    expect(initialsOf('Nguyen Cong Hau')).toBe('NH');
    expect(initialsOf('  alice  ')).toBe('A');
    expect(initialsOf('Đỗ Văn An')).toBe('ĐA');
  });
  it('falls back to the email, then to a placeholder', () => {
    expect(initialsOf(undefined, 'accountant@acme.example')).toBe('A');
    expect(initialsOf('', null)).toBe('?');
    expect(initialsOf(null)).toBe('?');
  });
});
