import { Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { auditLogs, documents, idempotencyKeys } from '../../../db/schema';
import { TenantDbService, type Tx } from '../../../db/tenant-db.service';
import { STORAGE_PORT, type StoragePort } from '../../storage/application/storage.port';
import { IDEMPOTENCY_KEY_REUSED, IDEMPOTENCY_WINDOW_HOURS } from '../domain/idempotency';
import type { UploadedObject } from '../infra/storage-multer-engine';

export const DOCUMENT_CREATED = 'document.created';

/** What the API exposes of a document: no storage key (an internal path) and no uploader. */
export interface DocumentView {
  id: string;
  status: string;
  sourceType: string;
  contentHash: string;
  version: number;
  createdAt: Date;
}

export interface CreateDocumentInput {
  tenantId: string;
  userId: string;
  ip: string | undefined;
  idempotencyKey: string;
  file: UploadedObject;
}

export interface CreateDocumentResult {
  document: DocumentView;
  /**
   * True only when this call inserted the row. The queue (T2.4) enqueues a job exactly then, so a
   * duplicate file or a replayed request never starts a second job.
   */
  created: boolean;
  /** Status of the original response: 201 if that call created the row, else 200. */
  statusCode: 200 | 201;
  /** The Idempotency-Key matched an earlier request, so this is that request's answer again. */
  replayed: boolean;
}

const VIEW = {
  id: documents.id,
  status: documents.status,
  sourceType: documents.sourceType,
  contentHash: documents.contentHash,
  version: documents.version,
  createdAt: documents.createdAt,
};

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /**
   * Registers an already stored file. Two layers keep it from being processed twice:
   * the Idempotency-Key (same request sent again, e.g. after a timeout, gets the same answer) and
   * UNIQUE (tenant_id, content_hash) (same bytes sent under any key map to the one document).
   * The file written for this request is deleted unless it became the document's file.
   */
  async create(input: CreateDocumentInput): Promise<CreateDocumentResult> {
    let result: CreateDocumentResult;
    try {
      result = await this.tenantDb.run(input.tenantId, (tx) => this.register(tx, input));
    } catch (e) {
      // Delete the file only when the transaction certainly rolled back. After any other error
      // (e.g. the connection dropped while COMMIT was acknowledged) the row may exist and point at
      // this file, so it stays for the orphan cleanup (M7/M8) rather than leave a document without one.
      if (e instanceof UnprocessableEntityException) await this.discard(input.file.storageKey);
      throw e;
    }
    if (!result.created) await this.discard(input.file.storageKey);
    return result;
  }

  private async register(tx: Tx, input: CreateDocumentInput): Promise<CreateDocumentResult> {
    const { file, idempotencyKey: key } = input;

    // An expired key is replaced by a fresh one; the primary key would otherwise block it forever.
    await tx
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, input.tenantId),
          eq(idempotencyKeys.key, key),
          sql`${idempotencyKeys.createdAt} <= now() - make_interval(hours => ${IDEMPOTENCY_WINDOW_HOURS})`,
        ),
      );
    const earlier = await this.findKey(tx, input.tenantId, key);
    if (earlier) return this.replay(tx, input.tenantId, earlier, file.sha256);

    const [inserted] = await tx
      .insert(documents)
      .values({
        tenantId: input.tenantId,
        sourceType: file.sourceType,
        storageKey: file.storageKey,
        contentHash: file.sha256,
        uploadedBy: input.userId,
      })
      // A concurrent insert of the same bytes makes this wait for its commit, then do nothing.
      .onConflictDoNothing({ target: [documents.tenantId, documents.contentHash] })
      .returning(VIEW);
    const created = inserted !== undefined;
    const document = inserted ?? (await this.findByHash(tx, input.tenantId, file.sha256));

    const statusCode = created ? 201 : 200;
    const [won] = await tx
      .insert(idempotencyKeys)
      .values({
        tenantId: input.tenantId,
        key,
        requestHash: file.sha256,
        documentId: document.id,
        statusCode,
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (!won) {
      // Another request with this key committed between our read and our insert: answer as it did.
      const winner = await this.findKey(tx, input.tenantId, key);
      if (!winner) throw new Error('Idempotency key vanished during insert');
      return this.replay(tx, input.tenantId, winner, file.sha256); // may throw; the rollback drops our insert
    }

    if (created) {
      await tx.insert(auditLogs).values({
        tenantId: input.tenantId,
        actorId: input.userId,
        action: DOCUMENT_CREATED,
        entity: 'document',
        entityId: document.id,
        meta: { sourceType: file.sourceType },
        ip: input.ip,
      });
    }
    return { document, created, statusCode, replayed: false };
  }

  private async replay(
    tx: Tx,
    tenantId: string,
    earlier: { requestHash: string; documentId: string; statusCode: number },
    requestHash: string,
  ): Promise<CreateDocumentResult> {
    if (earlier.requestHash !== requestHash) {
      throw new UnprocessableEntityException({
        message: 'This Idempotency-Key was already used with a different file',
        code: IDEMPOTENCY_KEY_REUSED,
      });
    }
    const [document] = await tx
      .select(VIEW)
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, earlier.documentId)));
    if (!document) throw new Error('Document of an idempotency key is missing');
    return {
      document,
      created: false,
      statusCode: earlier.statusCode === 201 ? 201 : 200,
      replayed: true,
    };
  }

  private async findKey(tx: Tx, tenantId: string, key: string) {
    const [row] = await tx
      .select({
        requestHash: idempotencyKeys.requestHash,
        documentId: idempotencyKeys.documentId,
        statusCode: idempotencyKeys.statusCode,
      })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, tenantId),
          eq(idempotencyKeys.key, key),
          gt(
            idempotencyKeys.createdAt,
            sql`now() - make_interval(hours => ${IDEMPOTENCY_WINDOW_HOURS})`,
          ),
        ),
      );
    return row;
  }

  private async findByHash(tx: Tx, tenantId: string, contentHash: string): Promise<DocumentView> {
    const [row] = await tx
      .select(VIEW)
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.contentHash, contentHash)));
    if (!row) throw new Error('Document vanished after a hash conflict');
    return row;
  }

  /** Best effort: a leftover file is harmless (and a later cleanup job's concern), a failure here must not hide the real result. */
  private async discard(storageKey: string): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch (e) {
      this.logger.warn(
        `Could not delete an unused upload (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }
}
