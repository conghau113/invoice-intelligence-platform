import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { DocumentStateMachine } from './application/document-state-machine';

/**
 * Separate from DocumentsModule so the worker can use the state machine without the HTTP/multer parts.
 * Exports the cache too: whoever changes a document invalidates the tenant's cached reads (T6.3).
 */
@Module({
  imports: [CacheModule],
  providers: [DocumentStateMachine],
  exports: [DocumentStateMachine, CacheModule],
})
export class DocumentStateModule {}
