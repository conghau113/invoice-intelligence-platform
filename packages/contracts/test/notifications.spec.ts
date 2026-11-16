import { NotificationPageSchema, NotificationSchema } from '../src';

const item = {
  id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  kind: 'extraction_failed',
  documentId: '0b6f6c1e-8f4b-4c55-9f0e-6f1d8a1b2c3d',
  failureCode: 'PDF_INVALID',
  createdAt: '2026-11-16T03:04:05.678Z',
  readAt: null,
};

describe('NotificationSchema', () => {
  it('accepts an unread failure with its code', () => {
    expect(NotificationSchema.parse(item)).toEqual(item);
  });

  it('accepts a read success with no code', () => {
    const read = {
      ...item,
      kind: 'extraction_succeeded',
      failureCode: null,
      readAt: '2026-11-16T03:05:00+07:00',
    };
    expect(NotificationSchema.safeParse(read).success).toBe(true);
  });

  it.each([
    ['an extra key (no content, no file name)', { ...item, fileName: 'SAMPLE.pdf' }],
    ['a failure code that is not in the list', { ...item, failureCode: 'Ngày sai' }],
    ['a date without a time', { ...item, createdAt: '2026-11-16' }],
  ])('refuses %s', (_name, value) => {
    expect(NotificationSchema.safeParse(value).success).toBe(false);
  });
});

describe('NotificationPageSchema', () => {
  const page = {
    items: [item],
    meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
    unreadCount: 1,
  };

  it('accepts a page with the unread count', () => {
    expect(NotificationPageSchema.safeParse(page).success).toBe(true);
  });

  it('refuses a limit above the maximum', () => {
    const big = { ...page, meta: { ...page.meta, limit: 51 } };
    expect(NotificationPageSchema.safeParse(big).success).toBe(false);
  });

  it('refuses a negative unread count', () => {
    expect(NotificationPageSchema.safeParse({ ...page, unreadCount: -1 }).success).toBe(false);
  });
});
