import { Module } from '@nestjs/common';
import { EXTRACTION_QUEUE_PORT } from './application/extraction-queue.port';
import { BullmqExtractionQueue } from './infra/bullmq-extraction-queue';

/** The producer side: anything that enqueues, lists or retries jobs imports this. No HTTP here. */
@Module({
  providers: [{ provide: EXTRACTION_QUEUE_PORT, useClass: BullmqExtractionQueue }],
  exports: [EXTRACTION_QUEUE_PORT],
})
export class QueueModule {}
