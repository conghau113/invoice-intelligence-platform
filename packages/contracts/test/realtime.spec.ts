import {
  DocumentUpdatedEventSchema,
  NotificationCreatedEventSchema,
  RealtimeTokenSchema,
} from '../src';

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

describe('NotificationCreatedEventSchema', () => {
  const created = {
    id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    kind: 'extraction_failed',
    documentId: event.id,
  };

  it('accepts ids and a kind', () => {
    expect(NotificationCreatedEventSchema.parse(created)).toEqual(created);
  });

  it.each([
    ['an extra key (content must never ride along)', { ...created, fileName: 'SAMPLE.pdf' }],
    ['a kind that is not known', { ...created, kind: 'invoice_approved' }],
    ['a document id that is not a uuid', { ...created, documentId: 'doc-1' }],
  ])('refuses %s', (_name, value) => {
    expect(NotificationCreatedEventSchema.safeParse(value).success).toBe(false);
  });
});
