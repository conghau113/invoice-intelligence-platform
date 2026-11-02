import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { DbModule } from '../../db/db.module';
import { DocumentStateModule } from '../documents/document-state.module';
import { AiExtractionHandler } from '../extraction/application/ai-extraction.handler';
import { ExtractionHandlerModule } from '../extraction/extraction-handler.module';
import { EXTRACTION_HANDLER } from './application/extraction-handler.port';
import { ExtractionProcessor } from './application/extraction.processor';
import { ExtractionWorker } from './infra/extraction-worker';

/** Root module of the worker process (src/worker.ts): database + queue consumer, no HTTP. */
@Module({
  imports: [ConfigModule, DbModule, DocumentStateModule, ExtractionHandlerModule],
  providers: [
    { provide: EXTRACTION_HANDLER, useExisting: AiExtractionHandler },
    ExtractionProcessor,
    ExtractionWorker,
  ],
})
export class WorkerModule {}
