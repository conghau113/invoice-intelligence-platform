import { Module } from '@nestjs/common';
import { RealtimePublisherModule } from '../realtime/realtime-publisher.module';
import { DOCUMENT_NOTIFIER } from './application/document-notifier.port';
import { StoredDocumentNotifier } from './application/stored-document-notifier';

/**
 * The writing side of notifications, for both processes: most notifications are written by the
 * worker (the end of an extraction). Imported by DocumentStateModule; no HTTP here.
 */
@Module({
  imports: [RealtimePublisherModule],
  providers: [{ provide: DOCUMENT_NOTIFIER, useClass: StoredDocumentNotifier }],
  exports: [DOCUMENT_NOTIFIER],
})
export class NotificationsWriterModule {}
