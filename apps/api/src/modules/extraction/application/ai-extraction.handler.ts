import { Inject, Injectable } from '@nestjs/common';
import { checkInvoice, mergeWarnings, todayInVietnam } from 'contracts';
import { and, eq } from 'drizzle-orm';
import type { Readable } from 'node:stream';
import { documents, extractions } from '../../../db/schema';
import { TenantDbService } from '../../../db/tenant-db.service';
import type { ExtractionHandler } from '../../queue/application/extraction-handler.port';
import {
  EXTRACTION_FAILED,
  PermanentExtractionError,
  type ExtractionJobData,
} from '../../queue/domain/extraction-job';
import {
  ObjectNotFoundError,
  STORAGE_PORT,
  type StoragePort,
} from '../../storage/application/storage.port';
import { FILE_MISSING, FILE_TOO_LARGE } from '../domain/ai-errors';
import { MAX_FILE_BYTES, isSourceType } from '../domain/ai-extract-response';
import { AI_EXTRACTOR, type AiExtractor } from './ai-extractor.port';

/**
 * T2.9: one extraction attempt = read the file (StoragePort) -> POST /extract -> store the answer.
 * The state changes (queued/processing/needs_review/failed) are the processor's job, not ours.
 * Database work happens in two short transactions with the slow AI call between them, so no
 * connection is held while we wait (Phát sinh T1.3).
 */
@Injectable()
export class AiExtractionHandler implements ExtractionHandler {
  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(AI_EXTRACTOR) private readonly ai: AiExtractor,
  ) {}

  async extract(job: ExtractionJobData): Promise<void> {
    const doc = await this.tenantDb.run(job.tenantId, async (tx) => {
      const [row] = await tx
        .select({
          storageKey: documents.storageKey,
          sourceType: documents.sourceType,
          version: documents.version,
        })
        .from(documents)
        .where(eq(documents.id, job.documentId));
      if (!row) return undefined;
      const [done] = await tx
        .select({ id: extractions.id })
        .from(extractions)
        .where(
          and(
            eq(extractions.documentId, job.documentId),
            eq(extractions.documentVersion, row.version),
          ),
        );
      return { ...row, alreadyExtracted: done !== undefined };
    });
    if (!doc || !isSourceType(doc.sourceType))
      throw new PermanentExtractionError(EXTRACTION_FAILED);
    // A redelivered job (crash after the insert, before the status change) must not call the AI
    // again: it would cost money on the LLM path (T3.2) and could only produce the same row.
    if (doc.alreadyExtracted) return;

    const bytes = await this.readFile(doc.storageKey);
    const started = Date.now();
    const result = await this.ai.extract({
      bytes,
      sourceType: doc.sourceType,
      traceparent: job.traceparent,
    });
    const measuredMs = Date.now() - started;
    // Business rules (T3.3, packages/contracts): warnings on fields, no number is changed. The
    // same function runs in the web form and, from T3.5, when a correction is saved.
    const warnings = mergeWarnings(
      result.warnings,
      checkInvoice(result.invoice, todayInVietnam(new Date())),
    );

    await this.tenantDb.run(job.tenantId, (tx) =>
      tx
        .insert(extractions)
        .values({
          tenantId: job.tenantId,
          documentId: job.documentId,
          documentVersion: doc.version,
          source: doc.sourceType,
          data: result.invoice,
          warnings,
          model: result.usage?.model ?? null,
          promptVersion: result.usage?.promptVersion ?? null,
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          latencyMs: result.usage?.latencyMs ?? measuredMs,
          costUsd: result.usage === null ? null : result.usage.costUsd.toFixed(6),
        })
        // The unique (document, version) key: a second delivery of the same job adds nothing.
        .onConflictDoNothing({ target: [extractions.documentId, extractions.documentVersion] }),
    );
  }

  /** Reads the whole object but never more than MAX_FILE_BYTES; a stored file cannot exceed it, so over the cap means something is wrong. */
  private async readFile(key: string): Promise<Buffer> {
    let stream: Readable;
    try {
      stream = await this.storage.get(key);
    } catch (e) {
      if (e instanceof ObjectNotFoundError) throw new PermanentExtractionError(FILE_MISSING);
      throw e; // anything else (disk trouble) may pass: retry
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buf.length;
      if (size > MAX_FILE_BYTES) {
        stream.destroy();
        throw new PermanentExtractionError(FILE_TOO_LARGE);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks, size);
  }
}
