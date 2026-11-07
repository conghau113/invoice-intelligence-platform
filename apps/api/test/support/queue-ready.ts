import type { INestApplication } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { EXTRACTION_QUEUE_PORT } from '../../src/modules/queue/application/extraction-queue.port';
import type { ExtractionQueuePort } from '../../src/modules/queue/application/extraction-queue.port';

/**
 * Waits until the app's Redis connection answers. The producer fails fast instead of queueing
 * commands (`enableOfflineQueue: false`), so a request sent before it has connected gets a 503 the
 * client can retry, and `/health/ready` reports the same. A test that uploads straight after
 * `app.init()` would depend on which of the two finishes first.
 */
export async function queueReady(app: INestApplication, ms = 10_000): Promise<void> {
  const queue = app.get<ExtractionQueuePort>(EXTRACTION_QUEUE_PORT, { strict: false });
  const until = Date.now() + ms;
  for (;;) {
    try {
      await queue.ping();
      return;
    } catch (e) {
      if (Date.now() >= until) throw e;
      await sleep(25);
    }
  }
}
