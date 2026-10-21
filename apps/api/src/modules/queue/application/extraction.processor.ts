import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { documents } from '../../../db/schema';
import { TenantDbService } from '../../../db/tenant-db.service';
import { DocumentStateMachine } from '../../documents/application/document-state-machine';
import { DocumentNotFoundError } from '../../documents/domain/document-not-found.error';
import { isDocumentStatus, type DocumentStatus } from '../../documents/domain/document-status';
import {
  EXTRACTION_FAILED,
  EXTRACTION_RETRIES_EXHAUSTED,
  EXTRACTION_RETRY,
  ExtractionJobError,
  PermanentExtractionError,
  extractionJobSchema,
} from '../domain/extraction-job';
import { EXTRACTION_HANDLER, type ExtractionHandler } from './extraction-handler.port';

export interface AttemptInfo {
  /** 1-based number of this attempt. */
  attempt: number;
  maxAttempts: number;
}

/** The job's work is already done or no longer wanted; running it again would be wrong. */
const SETTLED: ReadonlySet<DocumentStatus> = new Set([
  'needs_review',
  'approved',
  'rejected',
  'failed',
]);

/**
 * One attempt at one job, independent of BullMQ so it can be tested with plain fakes. The
 * document status is the source of truth: a job that arrives twice (at-least-once delivery) finds
 * the document already settled and does nothing, which is what makes the worker idempotent.
 * Each state change commits on its own, so an observer sees `processing` while the handler runs.
 */
@Injectable()
export class ExtractionProcessor {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly machine: DocumentStateMachine,
    @Inject(EXTRACTION_HANDLER) private readonly handler: ExtractionHandler,
  ) {}

  async process(raw: unknown, info: AttemptInfo): Promise<void> {
    const parsed = extractionJobSchema.safeParse(raw);
    // Never put the zod message in the error: it can echo a value from the job.
    if (!parsed.success) throw new ExtractionJobError(EXTRACTION_FAILED, false);
    const job = parsed.data;

    const status = await this.statusOf(job.tenantId, job.documentId);
    if (status === undefined) throw new ExtractionJobError(EXTRACTION_FAILED, false);
    if (SETTLED.has(status)) return;
    // `processing` here means an earlier run of this job died after starting (stalled job):
    // carry on from the state it left instead of failing the invalid processing -> processing edge.
    if (status === 'queued') await this.move(job.tenantId, job.documentId, 'processing');

    try {
      await this.handler.extract(job);
    } catch (e) {
      // The handler's message is deliberately dropped: it may contain document content.
      const permanent = e instanceof PermanentExtractionError;
      const exhausted = info.attempt >= info.maxAttempts;
      if (permanent || exhausted) {
        const code = permanent ? e.code : EXTRACTION_RETRIES_EXHAUSTED;
        await this.move(job.tenantId, job.documentId, 'failed', code);
        throw new ExtractionJobError(code, false);
      }
      await this.move(job.tenantId, job.documentId, 'queued', EXTRACTION_RETRY);
      throw new ExtractionJobError(EXTRACTION_RETRY, true);
    }
    await this.move(job.tenantId, job.documentId, 'needs_review');
  }

  /**
   * The queue gave up on a job (stalled too often, or the failure could not be recorded when it
   * happened). If the document is still queued or processing, mark it failed so the admin can see
   * and retry it. A document already settled is left alone, so calling this twice is harmless.
   */
  async settleFailure(raw: unknown, code: string): Promise<void> {
    const parsed = extractionJobSchema.safeParse(raw);
    if (!parsed.success) return;
    const { tenantId, documentId } = parsed.data;
    const status = await this.statusOf(tenantId, documentId);
    if (status !== 'queued' && status !== 'processing') return;
    if (status === 'queued') await this.move(tenantId, documentId, 'processing');
    await this.move(tenantId, documentId, 'failed', code);
  }

  private async statusOf(
    tenantId: string,
    documentId: string,
  ): Promise<DocumentStatus | undefined> {
    return this.tenantDb.run(tenantId, async (tx) => {
      const [row] = await tx
        .select({ status: documents.status })
        .from(documents)
        .where(eq(documents.id, documentId));
      return isDocumentStatus(row?.status) ? row.status : undefined;
    });
  }

  private async move(
    tenantId: string,
    documentId: string,
    to: DocumentStatus,
    code?: string,
  ): Promise<void> {
    try {
      await this.tenantDb.run(tenantId, () =>
        this.machine.transition(documentId, to, { actorId: null, code }),
      );
    } catch (e) {
      // The document vanished between the read and now: nothing to retry.
      if (e instanceof DocumentNotFoundError)
        throw new ExtractionJobError(EXTRACTION_FAILED, false);
      throw e;
    }
  }
}
