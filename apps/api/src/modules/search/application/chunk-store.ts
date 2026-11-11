import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { chunks } from '../../../db/schema';
import { TenantDbService } from '../../../db/tenant-db.service';

/** What other modules may do to the RAG index without going through the queue. */
@Injectable()
export class ChunkStore {
  constructor(private readonly tenantDb: TenantDbService) {}

  /**
   * Removes every chunk of a document in the CURRENT tenant transaction. Reopening calls it in the
   * same transaction as the status change (T3.8, T5.2): a reopened invoice is no longer approved,
   * so it must stop being retrievable at the moment the reopen commits, not at the next approval.
   * Returns how many chunks were removed.
   */
  async removeForDocument(tenantId: string, documentId: string): Promise<number> {
    const removed = await this.tenantDb
      .current()
      .delete(chunks)
      .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId)))
      .returning({ id: chunks.id });
    return removed.length;
  }
}
