import { Module } from '@nestjs/common';
import { ChunkStore } from './application/chunk-store';
import { INDEX_QUEUE_PORT } from './application/index-queue.port';
import { BullmqIndexQueue } from './infra/bullmq-index-queue';

/**
 * The API side of the RAG index (T5.2): approval enqueues an index job, reopening removes chunks.
 * The consumer (IndexProcessor, IndexWorker) runs in the worker process (queue/worker.module.ts).
 */
@Module({
  providers: [{ provide: INDEX_QUEUE_PORT, useClass: BullmqIndexQueue }, ChunkStore],
  exports: [INDEX_QUEUE_PORT, ChunkStore],
})
export class SearchModule {}
