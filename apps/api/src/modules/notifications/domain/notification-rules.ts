import type { NotificationKind } from 'contracts';
import type { DocumentStatus } from '../../documents/domain/document-status';

/**
 * Which status changes tell the uploader something (T6.5). Only the end of an extraction: the user
 * started it and is waiting for it. `queued`/`processing` are progress (realtime only, not stored),
 * and approving or reopening is something a user did themselves, so nobody needs to be told.
 * Both edges leave `processing`, which the worker alone takes, so a retry that fails again tells
 * the user again, and nothing a user clicks creates a notification.
 */
export function notificationKindFor(
  from: DocumentStatus,
  to: DocumentStatus,
): NotificationKind | null {
  if (from !== 'processing') return null;
  if (to === 'needs_review') return 'extraction_succeeded';
  if (to === 'failed') return 'extraction_failed';
  return null;
}
