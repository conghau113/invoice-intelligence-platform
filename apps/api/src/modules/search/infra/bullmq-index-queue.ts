import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../../../config/env.schema';
import { bounded } from '../../queue/infra/bullmq-extraction-queue';
import {
  COMMAND_TIMEOUT_MS,
  producerConnection,
  settleWithin,
} from '../../queue/infra/redis-connection';
import type { IndexQueuePort } from '../application/index-queue.port';
import {
  INDEX_MAX_ATTEMPTS,
  INDEX_QUEUE,
  indexJobSchema,
  type IndexJobData,
} from '../domain/index-job';

const DAY_SECONDS = 24 * 3600;

@Injectable()
export class BullmqIndexQueue implements IndexQueuePort, OnApplicationShutdown {
  private readonly connection: Redis;
  private readonly queue: Queue<IndexJobData>;

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    this.connection = producerConnection(config.get('REDIS_URL', { infer: true }));
    this.queue = new Queue<IndexJobData>(INDEX_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: INDEX_MAX_ATTEMPTS,
        backoff: { type: 'custom' },
        removeOnComplete: { age: DAY_SECONDS, count: 1_000 },
        // Kept for a week, like extraction: the dead-letter set of approved-but-not-indexed invoices.
        removeOnFail: { age: 7 * DAY_SECONDS },
      },
    });
    this.queue.on('error', () => new Logger('IndexQueue').error('Redis error'));
  }

  async enqueue(data: IndexJobData): Promise<void> {
    const valid = indexJobSchema.parse(data);
    await bounded(this.queue.add('index', valid, { jobId: valid.invoiceId }));
  }

  async onApplicationShutdown(): Promise<void> {
    await settleWithin(COMMAND_TIMEOUT_MS, this.queue.close());
    this.connection.disconnect();
  }
}
