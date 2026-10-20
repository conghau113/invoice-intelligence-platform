import { parseIdempotencyKey } from './idempotency';

describe('parseIdempotencyKey', () => {
  it.each(['3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11', 'a', 'k_1.2-3:x', 'x'.repeat(255)])(
    'accepts %s',
    (key) => expect(parseIdempotencyKey(key)).toBe(key),
  );

  it.each([
    undefined,
    '',
    'has space',
    'tab\there',
    'new\nline',
    'ünïcode',
    'x'.repeat(256),
    ['a', 'b'],
    42,
  ])('rejects %p', (key) => expect(parseIdempotencyKey(key)).toBeNull());
});
