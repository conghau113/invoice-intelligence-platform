import { describe, expect, it } from 'vitest';
import { isUuid } from './uuid';

describe('isUuid', () => {
  it.each(['3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11', '3F1C9A52-7D0E-4B7A-9C1D-2A6F0B8E4D11'])(
    'accepts %s',
    (value) => {
      expect(isUuid(value)).toBe(true);
    },
  );

  it.each([
    '',
    'nope',
    '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d1',
    '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d111',
    '3f1c9a52x7d0e-4b7a-9c1d-2a6f0b8e4d11',
    'g f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11',
    '../3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11',
    '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11\n',
  ])('refuses %j', (value) => {
    expect(isUuid(value)).toBe(false);
  });
});
