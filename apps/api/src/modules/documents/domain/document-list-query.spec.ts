import {
  DEFAULT_LIMIT,
  InvalidQueryError,
  MAX_LIMIT,
  MAX_PAGE,
  parseDocumentListQuery,
} from './document-list-query';

describe('parseDocumentListQuery', () => {
  it('applies defaults', () => {
    expect(parseDocumentListQuery({})).toEqual({
      page: 1,
      limit: DEFAULT_LIMIT,
      sort: '-createdAt',
    });
  });

  it('accepts every parameter', () => {
    const q = parseDocumentListQuery({
      page: '3',
      limit: '50',
      sort: 'createdAt',
      status: 'needs_review',
      type: 'xml',
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(q).toEqual({
      page: 3,
      limit: 50,
      sort: 'createdAt',
      status: 'needs_review',
      type: 'xml',
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it.each([
    ['page 0', { page: '0' }],
    ['negative page', { page: '-1' }],
    ['page over max', { page: String(MAX_PAGE + 1) }],
    ['page fraction', { page: '1.5' }],
    ['page text', { page: 'last' }],
    ['limit 0', { limit: '0' }],
    ['limit over max', { limit: String(MAX_LIMIT + 1) }],
    ['limit fraction', { limit: '1.5' }],
    ['unknown status', { status: 'done' }],
    ['unknown type', { type: 'exe' }],
    ['unknown sort', { sort: 'status' }],
    ['non-date', { from: 'yesterday' }],
    ['impossible date', { to: '2026-02-30' }],
    ['from after to', { from: '2026-10-02', to: '2026-10-01' }],
    ['repeated parameter', { status: ['queued', 'failed'] }],
    ['the old cursor parameter', { cursor: 'abc' }],
    ['unknown parameter', { tenant: 'x' }],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseDocumentListQuery(raw)).toThrow(InvalidQueryError);
  });

  it('accepts the largest allowed page and limit', () => {
    expect(
      parseDocumentListQuery({ page: String(MAX_PAGE), limit: String(MAX_LIMIT) }),
    ).toMatchObject({
      page: MAX_PAGE,
      limit: MAX_LIMIT,
    });
  });
});
