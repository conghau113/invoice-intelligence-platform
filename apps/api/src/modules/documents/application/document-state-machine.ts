import { Inject, Injectable, Optional } from '@nestjs/common';
import { DOCUMENT_UPDATED } from 'contracts';
import { eq } from 'drizzle-orm';
import { TenantDbService } from '../../../db/tenant-db.service';
import { auditLogs, documents } from '../../../db/schema';
import {
  assertTransition,
  DocumentVersionConflictError,
  InvalidDocumentTransitionError,
  isDocumentStatus,
  nextVersion,
  type DocumentStatus,
} from '../domain/document-status';
import { DocumentNotFoundError } from '../domain/document-not-found.error';
import {
  TENANT_CACHE_INVALIDATOR,
  type TenantCacheInvalidator,
} from '../../cache/application/tenant-read-cache';
import {
  NO_REALTIME,
  REALTIME_PUBLISHER,
  type RealtimePublisher,
} from '../../realtime/application/realtime-publisher.port';
import {
  DOCUMENT_NOTIFIER,
  NO_NOTIFIER,
  type DocumentNotifier,
} from '../../notifications/application/document-notifier.port';

export interface TransitionContext {
  /** Keycloak sub of the user, or null when the system acts (worker). */
  actorId: string | null;
  /** Machine-readable reason (e.g. a failure code). Never document content or PII. */
  code?: string;
  /**
   * The version the caller read earlier. Compared under the row lock, so nothing can change between
   * the check and the update. The status check is still needed: approving does not bump the version,
   * so two tabs that both read version 1 are told apart by `approved` -> `approved` being invalid.
   */
  expectedVersion?: number;
  /**
   * The only status this operation may start from. Needed when a target has several valid sources:
   * `processing` -> `needs_review` is a valid edge, but reopening a document must not take it.
   */
  expectedFrom?: DocumentStatus;
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
  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(TENANT_CACHE_INVALIDATOR) private readonly cache: TenantCacheInvalidator,
    @Optional()
    @Inject(REALTIME_PUBLISHER)
    private readonly realtime: RealtimePublisher = NO_REALTIME,
    @Optional()
    @Inject(DOCUMENT_NOTIFIER)
    private readonly notifier: DocumentNotifier = NO_NOTIFIER,
  ) {}

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
        uploadedBy: documents.uploadedBy,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .for('update');
    // RLS hides other tenants' rows, so "not yours" and "not there" look the same.
    if (!row) throw new DocumentNotFoundError();
    if (!isDocumentStatus(row.status)) throw new Error('Unknown document status in database');

    if (ctx.expectedVersion !== undefined && ctx.expectedVersion !== row.version) {
      throw new DocumentVersionConflictError();
    }
    if (ctx.expectedFrom !== undefined && ctx.expectedFrom !== row.status) {
      throw new InvalidDocumentTransitionError(row.status, to);
    }
    assertTransition(row.status, to);
    const version = nextVersion(row.status, to, row.version);

    // The reason is kept only while the document is `failed`: leaving that state (retry) clears it.
    const failureCode = to === 'failed' ? (ctx.code ?? null) : null;
    await tx
      .update(documents)
      .set({ status: to, version, failureCode })
      .where(eq(documents.id, documentId));
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
    // In this transaction, not after it: the notification exists exactly when the status does, so
    // a crash between COMMIT and a later write cannot lose it (T6.5, ADR 0014: offline delivery).
    await this.notifier.onTransition({
      tenantId: row.tenantId,
      documentId,
      uploadedBy: row.uploadedBy,
      from: row.status,
      to,
      failureCode,
    });

    // Every list and dashboard number of the tenant may have changed. After COMMIT, never before:
    // a reader in between would cache the old rows again (ADR 0013, T6.3).
    this.tenantDb.afterCommit(() => this.cache.invalidate(row.tenantId));
    // Pushed after the invalidation above, so a browser that reads on this event gets fresh rows.
    // Ids and the status only (T6.4); the browser reads the rest through REST, with RLS.
    this.tenantDb.afterCommit(() =>
      this.realtime.toTenant(row.tenantId, {
        name: DOCUMENT_UPDATED,
        payload: { id: documentId, status: to, version },
      }),
    );
    return { from: row.status, to, version };
  }
}
