import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import vi from '../../messages/vi.json';

describe('messages', () => {
  it('translate the same key differently per locale', () => {
    const tv = createTranslator({ locale: 'vi', messages: vi, namespace: 'Dashboard' });
    const te = createTranslator({ locale: 'en', messages: en, namespace: 'Dashboard' });
    expect(tv('signOut')).toBe('Đăng xuất');
    expect(te('signOut')).toBe('Sign out');
  });
});
