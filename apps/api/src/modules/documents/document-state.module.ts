import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { RealtimePublisherModule } from '../realtime/realtime-publisher.module';
import { DocumentStateMachine } from './application/document-state-machine';

/**
 * Separate from DocumentsModule so the worker can use the state machine without the HTTP/multer parts.
 * Exports the cache too: whoever changes a document invalidates the tenant's cached reads (T6.3).
 * Realtime: every committed status change is pushed to the tenant's browsers (T6.4).
 */
@Module({
  imports: [CacheModule, RealtimePublisherModule],
  providers: [DocumentStateMachine],
  exports: [DocumentStateMachine, CacheModule],
})
export class DocumentStateModule {}
