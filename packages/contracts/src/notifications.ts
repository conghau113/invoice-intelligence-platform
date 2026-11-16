import { z } from 'zod';
import { DOCUMENT_FAILURE_CODES } from './error-codes';

/**
 * In-app notifications (T6.5, ADR 0014, API.md "Notifications"). Stored per user, so a user who was
 * offline sees them when they come back; pushed as `notification.created` when they are online.
 * Ids and codes only: the web builds the sentence from `kind` and `failureCode` in the user's language.
 */
export const NOTIFICATION_KINDS = ['extraction_succeeded', 'extraction_failed'] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/** Most notifications in one page of `GET /notifications`. */
export const NOTIFICATIONS_MAX_LIMIT = 50;
/** Highest `page` accepted (OFFSET reads and discards every earlier row), same as the documents list. */
export const NOTIFICATIONS_MAX_PAGE = 10_000;

export const NotificationSchema = z.strictObject({
  id: z.uuid(),
  kind: NotificationKindSchema,
  documentId: z.uuid(),
  /** Why extraction failed; null unless `kind` is `extraction_failed` (and may be null then). */
  failureCode: z.enum(DOCUMENT_FAILURE_CODES).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /** Null while unread. */
  readAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/** `GET /notifications`: one page, newest first (ADR 0019), and the user's unread count. */
export const NotificationPageSchema = z.strictObject({
  items: z.array(NotificationSchema).max(NOTIFICATIONS_MAX_LIMIT),
  meta: z.strictObject({
    page: z.int().min(1),
    limit: z.int().min(1).max(NOTIFICATIONS_MAX_LIMIT),
    total: z.int().min(0),
    totalPages: z.int().min(0),
  }),
  /** Unread notifications of the user in this tenant, on every page (the badge). */
  unreadCount: z.int().min(0),
});
export type NotificationPage = z.infer<typeof NotificationPageSchema>;
