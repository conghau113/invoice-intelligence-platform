import { NOTIFICATIONS_MAX_LIMIT, NOTIFICATIONS_MAX_PAGE } from 'contracts';
import { z } from 'zod';
import { InvalidQueryError } from '../../documents/domain/document-list-query';

export const DEFAULT_NOTIFICATIONS_LIMIT = 20;

export interface NotificationListQuery {
  page: number;
  limit: number;
}

const schema = z.strictObject({
  page: z.coerce.number().int().min(1).max(NOTIFICATIONS_MAX_PAGE).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTIFICATIONS_MAX_LIMIT)
    .default(DEFAULT_NOTIFICATIONS_LIMIT),
});

/** Same rules as the documents list (ADR 0019). Throws InvalidQueryError (400 `INVALID_QUERY`). */
export function parseNotificationListQuery(raw: unknown): NotificationListQuery {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new InvalidQueryError();
  return parsed.data;
}
