import { ConflictException, Injectable } from '@nestjs/common';
import { isUuid } from '../../../common/uuid';
import { auditLogs } from '../../../db/schema';
import { TenantDbService } from '../../../db/tenant-db.service';
import { DocumentStateMachine } from '../../documents/application/document-state-machine';
import { DocumentNotFoundError } from '../../documents/domain/document-not-found.error';
import { ChunkStore } from '../../search/application/chunk-store';
import { MAX_DOCUMENT_VERSION } from '../domain/approve-limits';
import { REOPEN_LIMIT_REACHED } from '../domain/review-errors';

export const DOCUMENT_REOPENED = 'document.reopened';

export interface ReopenInput {
  documentId: string;
  tenantId: string;
  userId: string;
  ip: string | undefined;
  /** The document version the person was looking at (from If-Match). */
  expectedVersion: number;
}

export interface ReopenResult {
  id: string;
  status: 'needs_review';
  version: number;
}

@Injectable()
export class ReopenService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly machine: DocumentStateMachine,
    private readonly chunkStore: ChunkStore,
  ) {}

  /**
   * Runs in the request's tenant transaction, so the status change and the audit entry commit
   * together. The approved invoice stays: bumping the version is what makes it stop counting as
   * approved (`current_invoices`), and the form reopens with its values. Its RAG chunks are
   * removed in the same transaction (T5.2): from the commit on, Q&A can no longer find them.
   */
  async reopen(input: ReopenInput): Promise<ReopenResult> {
    if (!isUuid(input.documentId)) throw new DocumentNotFoundError();

    const { version } = await this.machine.transition(input.documentId, 'needs_review', {
      actorId: input.userId,
      expectedVersion: input.expectedVersion,
      expectedFrom: 'approved',
    });
    // After the transition, so it is checked under the row lock; throwing rolls that back.
    if (version > MAX_DOCUMENT_VERSION) {
      throw new ConflictException({
        message: 'This document has been reopened too many times',
        code: REOPEN_LIMIT_REACHED,
      });
    }

    const chunksRemoved = await this.chunkStore.removeForDocument(input.tenantId, input.documentId);

    // Numbers only (SECURITY.md section 5): the values themselves stay out of the audit log.
    await this.tenantDb
      .current()
      .insert(auditLogs)
      .values({
        tenantId: input.tenantId,
        actorId: input.userId,
        action: DOCUMENT_REOPENED,
        entity: 'document',
        entityId: input.documentId,
        meta: { fromVersion: input.expectedVersion, version, chunksRemoved },
        ip: input.ip,
      });

    return { id: input.documentId, status: 'needs_review', version };
  }
}
