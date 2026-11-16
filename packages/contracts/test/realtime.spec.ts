import { DocumentUpdatedEventSchema, RealtimeTokenSchema } from '../src';

const event = { id: '0b6f6c1e-8f4b-4c55-9f0e-6f1d8a1b2c3d', status: 'needs_review', version: 1 };

describe('DocumentUpdatedEventSchema', () => {
  it('accepts ids, a status and a version', () => {
    expect(DocumentUpdatedEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    ['an extra key (content must never ride along)', { ...event, sellerName: 'SAMPLE' }],
    ['an id that is not a uuid', { ...event, id: 'doc-1' }],
    ['a status that is not a status word', { ...event, status: '<b>approved</b>' }],
    ['version 0', { ...event, version: 0 }],
  ])('refuses %s', (_name, value) => {
    expect(DocumentUpdatedEventSchema.safeParse(value).success).toBe(false);
  });
});

describe('RealtimeTokenSchema', () => {
  it('accepts a token and its lifetime', () => {
    expect(RealtimeTokenSchema.safeParse({ token: 'a.b.c', expiresIn: 60 }).success).toBe(true);
  });

  it('refuses an empty token', () => {
    expect(RealtimeTokenSchema.safeParse({ token: '', expiresIn: 60 }).success).toBe(false);
  });
});
