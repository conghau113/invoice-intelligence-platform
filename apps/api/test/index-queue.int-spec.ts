/**
 * BullmqIndexQueue against a real Redis (T5.2). The index job's idempotency rests on BullMQ's rule
 * that a job id already present is not added again; the in-memory FakeIndexQueue only imitates it,
 * so the real adapter is checked here: one job per invoice id, with the retry budget and ids only.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { StartedTestContainer } from 'testcontainers';
import type { Env } from '../src/config/env.schema';
import { INDEX_MAX_ATTEMPTS, INDEX_QUEUE } from '../src/modules/search/domain/index-job';
import { BullmqIndexQueue } from '../src/modules/search/infra/bullmq-index-queue';
import { startRedis } from './support/reachable-container';

const TENANT = '00000000-0000-4000-8000-0000000000a1';

describe('BullmqIndexQueue (real Redis)', () => {
  let redis: StartedTestContainer;
  let producer: BullmqIndexQueue;
  let inspect: Queue;

  const job = (invoiceId = randomUUID(), documentVersion = 1) => ({
    tenantId: TENANT,
    documentId: randomUUID(),
    documentVersion,
    invoiceId,
  });

  /** The producer fails fast while Redis is still connecting (no offline queue): wait for it. */
  async function enqueueWhenReady(data: ReturnType<typeof job>): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        return await producer.enqueue(data);
      } catch (e) {
        if (i > 200) throw e;
        await sleep(25);
      }
    }
  }

  beforeAll(async () => {
    redis = await startRedis();
    const url = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    producer = new BullmqIndexQueue({
      get: (k: keyof Env) => (k === 'REDIS_URL' ? url : undefined),
    } as unknown as ConfigService<Env, true>);
    inspect = new Queue(INDEX_QUEUE, { connection: { url } });
  }, 120_000);
  afterAll(async () => {
    await producer.onApplicationShutdown();
    await inspect.close();
    await redis.stop().catch(() => undefined);
  });

  it('the job id is the invoice id; the job holds ids only and the retry budget', async () => {
    const data = job();
    await enqueueWhenReady(data);
    const stored = await inspect.getJob(data.invoiceId);
    expect(stored?.data).toEqual(data);
    expect(stored?.opts.attempts).toBe(INDEX_MAX_ATTEMPTS);
    expect(stored?.opts.backoff).toEqual({ type: 'custom' });
  });

  it('the same approval enqueued twice is one job (the second add is a no-op)', async () => {
    const data = job();
    await enqueueWhenReady(data);
    await enqueueWhenReady({ ...data, documentVersion: 2 });
    const stored = await inspect.getJob(data.invoiceId);
    expect(stored?.data.documentVersion).toBe(1);
    const all = await inspect.getJobs(['waiting', 'delayed', 'active']);
    expect(all.filter((j) => j.id === data.invoiceId)).toHaveLength(1);
  });

  it('two approvals of one document (two invoice rows) are two jobs', async () => {
    const first = job();
    const second = { ...first, invoiceId: randomUUID(), documentVersion: 2 };
    await enqueueWhenReady(first);
    await enqueueWhenReady(second);
    expect(await inspect.getJob(first.invoiceId)).toBeDefined();
    expect(await inspect.getJob(second.invoiceId)).toBeDefined();
  });

  it('a payload with an extra field is refused before it reaches Redis', async () => {
    const data = { ...job(), content: 'SAMPLE' };
    await expect(producer.enqueue(data)).rejects.toThrow();
    expect(await inspect.getJob(data.invoiceId)).toBeUndefined();
  });
});
