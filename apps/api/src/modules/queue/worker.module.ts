import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { DbModule } from '../../db/db.module';
import { DocumentStateModule } from '../documents/document-state.module';
import { EXTRACTION_HANDLER } from './application/extraction-handler.port';
import { ExtractionProcessor } from './application/extraction.processor';
import { PlaceholderExtractionHandler } from './application/placeholder-extraction.handler';
import { ExtractionWorker } from './infra/extraction-worker';

/** Root module of the worker process (src/worker.ts): database + queue consumer, no HTTP. */
@Module({
  imports: [ConfigModule, DbModule, DocumentStateModule],
  providers: [
    // T2.9 replaces this with the handler that calls the AI service.
    { provide: EXTRACTION_HANDLER, useClass: PlaceholderExtractionHandler },
    ExtractionProcessor,
    ExtractionWorker,
  ],
})
export class WorkerModule {}
