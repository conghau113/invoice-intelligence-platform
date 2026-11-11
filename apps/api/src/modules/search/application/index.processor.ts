import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { chunks, documents } from '../../../db/schema';
import { TenantDbService, type Tx } from '../../../db/tenant-db.service';
import type { AiIndexResponse } from '../domain/ai-index-response';
import {
  INDEX_FAILED,
  INDEX_JOB_INVALID,
  INDEX_RESPONSE_MISMATCH,
  INDEX_RETRY,
  IndexJobError,
  PermanentIndexError,
  indexJobSchema,
  type IndexJobData,
} from '../domain/index-job';
import { AI_INDEXER, type AiIndexer, type CurrentInvoiceRow } from './ai-indexer.port';

export interface IndexAttemptInfo {
  /** 1-based number of this attempt. */
  attempt: number;
  maxAttempts: number;
}

/** Rows per insert: 51 chunks at most (500 lines, T5.1 groups of 10), far below Postgres' limits. */
const INSERT_BATCH = 100;

/**
 * One attempt at one index job, independent of BullMQ. What may be written is decided by the
 * document row, read under `FOR SHARE`: approval and reopening hold `FOR UPDATE` on it until they
 * commit, so this waits for them and then sees their result.
 *
 * - Before: the job is enqueued inside the approval's transaction, so it can arrive before that
 *   commits. The lock makes the read wait; if the approval rolled back, its invoice row does not
 *   exist and the job ends without writing anything.
 * - After the AI call (made outside any transaction): the document must still be approved at the
 *   job's version. A reopen in between deleted the chunks and bumped the version, so the job writes
 *   nothing; a later version has its own job. Otherwise the document's chunks are replaced as a
 *   whole, which makes running the same job twice harmless (idempotent per version).
 */
@Injectable()
export class IndexProcessor {
  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(AI_INDEXER) private readonly ai: AiIndexer,
  ) {}

  /** Resolves `true` when chunks were written, `false` when the job no longer applies. */
  async process(raw: unknown, info: IndexAttemptInfo): Promise<boolean> {
    const parsed = indexJobSchema.safeParse(raw);
    // Never put the zod message in the error: it can echo a value from the job.
    if (!parsed.success) throw new IndexJobError(INDEX_JOB_INVALID, false);
    const job = parsed.data;

    const row = await this.tenantDb.run(job.tenantId, async (tx) =>
      (await this.stillCurrent(tx, job)) ? this.currentRow(tx, job) : undefined,
    );
    if (row === undefined) return false;

    let result: AiIndexResponse;
    try {
      result = await this.ai.index(row);
    } catch (e) {
      // The indexer's message is dropped on purpose: it may contain document content.
      if (e instanceof PermanentIndexError) throw new IndexJobError(e.code, false);
      if (info.attempt >= info.maxAttempts) throw new IndexJobError(INDEX_FAILED, false);
      throw new IndexJobError(INDEX_RETRY, true);
    }
    if (!matchesJob(result, job)) throw new IndexJobError(INDEX_RESPONSE_MISMATCH, false);

    return this.tenantDb.run(job.tenantId, async (tx) => {
      if (!(await this.stillCurrent(tx, job))) return false;
      await tx
        .delete(chunks)
        .where(and(eq(chunks.tenantId, job.tenantId), eq(chunks.documentId, job.documentId)));
      const rows = result.chunks.map(({ chunk, embedding }) => ({
        tenantId: job.tenantId,
        documentId: job.documentId,
        documentVersion: job.documentVersion,
        invoiceId: job.invoiceId,
        kind: chunk.kind,
        ordinal: chunk.ordinal,
        content: chunk.content,
        embedding,
        embeddingModel: result.model,
        refs: chunk.refs,
      }));
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        await tx.insert(chunks).values(rows.slice(i, i + INSERT_BATCH));
      }
      return true;
    });
  }

  /** Locks the document row (shared) and tells whether it is still approved at the job's version. */
  private async stillCurrent(tx: Tx, job: IndexJobData): Promise<boolean> {
    const [doc] = await tx
      .select({ status: documents.status, version: documents.version })
      .from(documents)
      // RLS already scopes this to the job's tenant; the explicit filter is the second layer.
      .where(and(eq(documents.id, job.documentId), eq(documents.tenantId, job.tenantId)))
      .for('share');
    return doc?.status === 'approved' && doc.version === job.documentVersion;
  }

  /** The view, never the table `invoices`: that one keeps every version (T3.8, DATA_MODEL.md). */
  private async currentRow(tx: Tx, job: IndexJobData): Promise<CurrentInvoiceRow | undefined> {
    const { rows } = await tx.execute<CurrentInvoiceRow>(sql`
      SELECT id, tenant_id, document_id, document_version, data
        FROM current_invoices
       WHERE id = ${job.invoiceId} AND document_id = ${job.documentId}
         AND document_version = ${job.documentVersion} AND tenant_id = ${job.tenantId}`);
    return rows[0];
  }
}

/**
 * Every chunk must belong to exactly the invoice, tenant and version the job is about, and the set
 * must have the shape of T5.1 (a header at ordinal 0, ordinals unique). Checked here, not left to
 * the UNIQUE constraint: a database error is retried, and retrying a broken answer would spend an
 * embedding call per attempt for a result that can never be written.
 */
function matchesJob(result: AiIndexResponse, job: IndexJobData): boolean {
  const [first] = result.chunks;
  const ordinals = new Set(result.chunks.map(({ chunk }) => chunk.ordinal));
  return (
    first?.chunk.kind === 'header' &&
    first.chunk.ordinal === 0 &&
    ordinals.size === result.chunks.length &&
    result.chunks.every(
      ({ chunk }) =>
        chunk.tenant_id === job.tenantId &&
        chunk.document_id === job.documentId &&
        chunk.document_version === job.documentVersion &&
        chunk.invoice_id === job.invoiceId &&
        chunk.refs.every((ref) => ref.document_id === job.documentId),
    )
  );
}
