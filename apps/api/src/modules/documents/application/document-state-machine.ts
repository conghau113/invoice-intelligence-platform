import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { TenantDbService } from '../../../db/tenant-db.service';
import { auditLogs, documents } from '../../../db/schema';
import {
  assertTransition,
  isDocumentStatus,
  nextVersion,
  type DocumentStatus,
} from '../domain/document-status';
import { DocumentNotFoundError } from '../domain/document-not-found.error';

export interface TransitionContext {
  /** Keycloak sub of the user, or null when the system acts (worker). */
  actorId: string | null;
  /** Machine-readable reason (e.g. a failure code). Never document content or PII. */
  code?: string;
}

export interface TransitionResult {
  from: DocumentStatus;
  to: DocumentStatus;
  version: number;
}

/** Audit meta must stay free of content/PII, so only short UPPER_SNAKE codes are accepted. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

export const DOCUMENT_STATUS_CHANGED = 'document.status_changed';

/**
 * The only code allowed to change `documents.status` (ARCHITECTURE.md section 8). Must run inside
 * a tenant transaction (`TenantDbService.run`, or the request interceptor): status change and
 * audit entry commit or roll back together, and RLS scopes the row to the current tenant.
 */
@Injectable()
export class DocumentStateMachine {
  constructor(private readonly tenantDb: TenantDbService) {}

  async transition(
    documentId: string,
    to: DocumentStatus,
    ctx: TransitionContext,
  ): Promise<TransitionResult> {
    if (ctx.code !== undefined && !CODE_PATTERN.test(ctx.code)) {
      throw new Error('Transition code must be UPPER_SNAKE_CASE');
    }
    const tx = this.tenantDb.current();

    // FOR UPDATE: a concurrent transition waits here, then sees the new status and fails
    // validation instead of both passing on a stale read.
    const [row] = await tx
      .select({
        tenantId: documents.tenantId,
        status: documents.status,
        version: documents.version,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .for('update');
    // RLS hides other tenants' rows, so "not yours" and "not there" look the same.
    if (!row) throw new DocumentNotFoundError();
    if (!isDocumentStatus(row.status)) throw new Error('Unknown document status in database');

    assertTransition(row.status, to);
    const version = nextVersion(row.status, to, row.version);

    await tx.update(documents).set({ status: to, version }).where(eq(documents.id, documentId));
    await tx.insert(auditLogs).values({
      tenantId: row.tenantId,
      actorId: ctx.actorId,
      action: DOCUMENT_STATUS_CHANGED,
      entity: 'document',
      entityId: documentId,
      meta:
        ctx.code === undefined
          ? { from: row.status, to }
          : { from: row.status, to, code: ctx.code },
    });

    return { from: row.status, to, version };
  }
}
