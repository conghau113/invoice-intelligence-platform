import { Inject, Injectable } from '@nestjs/common';
import { isDocumentFailureCode, NOTIFICATION_CREATED } from 'contracts';
import { notifications } from '../../../db/schema';
import { TenantDbService } from '../../../db/tenant-db.service';
import {
  REALTIME_PUBLISHER,
  type RealtimePublisher,
} from '../../realtime/application/realtime-publisher.port';
import { notificationKindFor } from '../domain/notification-rules';
import type { DocumentNotifier, DocumentTransition } from './document-notifier.port';

/**
 * Both halves of delivery (ADR 0014). Offline: the row, written in the caller's transaction, so a
 * user who was away finds it in the list; there is no gap between "status committed" and
 * "notification stored" for a crash to fall into. Online: a push to the user's own room after
 * COMMIT, which the browser takes as "read the list again". A lost push costs nothing but latency.
 */
@Injectable()
export class StoredDocumentNotifier implements DocumentNotifier {
  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher,
  ) {}

  async onTransition(change: DocumentTransition): Promise<void> {
    const kind = notificationKindFor(change.from, change.to);
    if (kind === null) return;
    // Only codes from the shared list reach a browser; anything else is shown as "failed".
    const failureCode =
      kind === 'extraction_failed' && isDocumentFailureCode(change.failureCode)
        ? change.failureCode
        : null;

    const [row] = await this.tenantDb
      .current()
      .insert(notifications)
      .values({
        tenantId: change.tenantId,
        userId: change.uploadedBy,
        kind,
        documentId: change.documentId,
        failureCode,
      })
      .returning({ id: notifications.id });
    if (!row) throw new Error('Notification insert returned no row');

    this.tenantDb.afterCommit(() =>
      this.realtime.toUser(change.tenantId, change.uploadedBy, {
        name: NOTIFICATION_CREATED,
        payload: { id: row.id, kind, documentId: change.documentId },
      }),
    );
  }
}
