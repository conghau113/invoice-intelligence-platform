import { InvalidQueryError } from '../../documents/domain/document-list-query';
import { parseNotificationListQuery } from './notification-query';

describe('parseNotificationListQuery', () => {
  it('defaults to the first page of 20', () => {
    expect(parseNotificationListQuery({})).toEqual({ page: 1, limit: 20 });
  });

  it('reads numbers from the query string', () => {
    expect(parseNotificationListQuery({ page: '3', limit: '50' })).toEqual({ page: 3, limit: 50 });
  });

  it.each([
    ['a limit above 50', { limit: '51' }],
    ['page 0', { page: '0' }],
    ['an unknown parameter', { status: 'unread' }],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseNotificationListQuery(raw)).toThrow(InvalidQueryError);
  });
});
