import { Module } from '@nestjs/common';
import { QUERY_EMBEDDER } from './application/query-embedder.port';
import { RetrievalService } from './application/retrieval';
import { SearchDebugController } from './http/search-debug.controller';
import { HttpQueryEmbedder } from './infra/http-query-embedder';

/**
 * Hybrid retrieval (T5.3): vector + full-text search over `chunks`, fused with RRF. Exported for
 * Q&A (T5.4); the debug route shows the ranks and scores. Kept apart from SearchModule (the index
 * side that approval and reopen need) so that importing the index does not pull in the AI client.
 */
@Module({
  controllers: [SearchDebugController],
  providers: [{ provide: QUERY_EMBEDDER, useClass: HttpQueryEmbedder }, RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
