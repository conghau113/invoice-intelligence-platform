import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { AI_EXTRACTOR } from './application/ai-extractor.port';
import { AiExtractionHandler } from './application/ai-extraction.handler';
import { HttpAiExtractor } from './infra/http-ai-extractor';

/** What the worker process runs for each job: read the file, call the AI service, store the result. */
@Module({
  imports: [StorageModule],
  providers: [{ provide: AI_EXTRACTOR, useClass: HttpAiExtractor }, AiExtractionHandler],
  exports: [AiExtractionHandler],
})
export class ExtractionHandlerModule {}
