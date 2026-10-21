import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { documents } from '../../../db/schema';
import { TenantDbService } from '../../../db/tenant-db.service';
import { DocumentStateMachine } from '../../documents/application/document-state-machine';
import { DocumentNotFoundError } from '../../documents/domain/document-not-found.error';
import { JOB_FAILED_IN_QUEUE, MANUAL_RETRY } from '../domain/extraction-job';
import {
  EXTRACTION_QUEUE_PORT,
  type ExtractionQueuePort,
  type FailedJobView,
} from './extraction-queue.port';
import { queueUnavailable } from './queue-unavailable';

export class JobNotFailedError extends Error {
  readonly code = 'JOB_NOT_FAILED';
  constructor() {
    super('Job is not in the failed state');
    this.name = 'JobNotFailedError';
  }
}

/** One page; an admin with more failures than this fixes the cause first. */
const LIST_LIMIT = 200;

@Injectable()
export class AdminJobsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly machine: DocumentStateMachine,
    @Inject(EXTRACTION_QUEUE_PORT) private readonly queue: ExtractionQueuePort,
  ) {}

  /**
   * Failed documents of the tenant. Postgres is the source of truth (RLS scopes it to the caller,
   * and a Redis flush or the 7-day job expiry cannot hide a failure); the queue only adds the
   * attempt count, and the list still works when Redis is down.
   */
  async listFailed(tenantId: string): Promise<FailedJobView[]> {
    const rows = await this.tenantDb.run(tenantId, async (tx) => {
      const result = await tx.execute<{ id: string; at: Date; code: string | null }>(sql`
        SELECT d.id, a.at, a.meta->>'code' AS code
        FROM documents d
        JOIN LATERAL (
          SELECT at, meta FROM audit_logs
          WHERE entity = 'document' AND entity_id = d.id AND meta->>'to' = 'failed'
          ORDER BY at DESC LIMIT 1
        ) a ON true
        WHERE d.status = 'failed'
        ORDER BY a.at DESC
        LIMIT ${LIST_LIMIT}`);
      return result.rows;
    });
    let attempts = new Map<string, number>();
    try {
      attempts = await this.queue.attemptsMade(
        tenantId,
        rows.map((r) => r.id),
      );
    } catch {
      // Redis is down: the list is still right, only the attempt counts are unknown.
    }
    return rows.map((r) => ({
      documentId: r.id,
      attemptsMade: attempts.get(r.id) ?? null,
      reason: r.code,
      failedAt: new Date(r.at),
    }));
  }

  /**
   * Puts a failed document back in the queue with a fresh set of attempts. The queue is asked
   * first, so Redis being down changes nothing in the database. Then the document goes to `queued`
   * (the worker skips a document that is still `failed`) and the job is re-armed, or created again
   * when it has expired. A `processing` document whose job already failed (the worker died, or
   * the database failed on the last attempt) is let through failed -> queued in the same
   * transaction. Calling it again after a Redis failure in the last step finishes the job.
   */
  async retry(tenantId: string, userId: string, documentId: string): Promise<void> {
    const status = await this.statusOf(tenantId, documentId);
    if (status === undefined) throw new DocumentNotFoundError();
    if (status !== 'failed' && status !== 'processing' && status !== 'queued') {
      throw new JobNotFailedError();
    }

    const state = await this.viaQueue(() => this.queue.jobState(tenantId, documentId));
    // Waiting, running or finished: nothing to retry (and a running job must not be hijacked).
    if (state === 'other') throw new JobNotFailedError();

    if (status !== 'queued') {
      await this.tenantDb.run(tenantId, async () => {
        if (status === 'processing') {
          await this.machine.transition(documentId, 'failed', {
            actorId: userId,
            code: JOB_FAILED_IN_QUEUE,
          });
        }
        await this.machine.transition(documentId, 'queued', {
          actorId: userId,
          code: MANUAL_RETRY,
        });
      });
    }

    const outcome =
      state === 'failed'
        ? await this.viaQueue(() => this.queue.retryFailed(tenantId, documentId))
        : 'not_found';
    if (outcome === 'not_failed') throw new JobNotFailedError();
    // The job expired or was flushed: the document id is the job id, so adding it again is safe.
    if (outcome === 'not_found') {
      await this.viaQueue(() => this.queue.enqueue({ documentId, tenantId }));
    }
  }

  private async statusOf(tenantId: string, documentId: string): Promise<string | undefined> {
    return this.tenantDb.run(tenantId, async (tx) => {
      const [row] = await tx
        .select({ status: documents.status })
        .from(documents)
        .where(eq(documents.id, documentId));
      return row?.status;
    });
  }

  /** Any Redis failure becomes the same 503 as on upload. */
  private async viaQueue<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch {
      throw queueUnavailable();
    }
  }
}
