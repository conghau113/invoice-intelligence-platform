import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { InvoiceSchema, type Invoice } from 'contracts';
import { isUuid } from '../../../common/uuid';
import { documents, extractions } from '../../../db/schema';
import { TenantDbService } from '../../../db/tenant-db.service';
import { DocumentNotFoundError } from '../../documents/domain/document-not-found.error';
import { ExtractionDataInvalidError } from '../domain/ai-errors';

export interface ExtractionView {
  id: string;
  documentVersion: number;
  source: string;
  data: Invoice;
  warnings: unknown[];
  createdAt: Date;
}

/** API.md `GET /documents/:id`: the document plus its latest extraction (null until one exists). */
export interface DocumentDetail {
  id: string;
  status: string;
  sourceType: string;
  version: number;
  createdAt: Date;
  /** Why the document is `failed` (a code the UI translates); null in every other status. */
  failureCode: string | null;
  extraction: ExtractionView | null;
}

@Injectable()
export class DocumentDetailService {
  constructor(private readonly tenantDb: TenantDbService) {}

  /** Runs in the request's tenant transaction, so RLS hides other tenants' documents (404). */
  async get(id: string): Promise<DocumentDetail> {
    if (!isUuid(id)) throw new DocumentNotFoundError();
    const tx = this.tenantDb.current();
    const [doc] = await tx
      .select({
        id: documents.id,
        status: documents.status,
        sourceType: documents.sourceType,
        version: documents.version,
        createdAt: documents.createdAt,
        failureCode: documents.failureCode,
      })
      .from(documents)
      .where(eq(documents.id, id));
    if (!doc) throw new DocumentNotFoundError();

    const [row] = await tx
      .select()
      .from(extractions)
      .where(eq(extractions.documentId, id))
      .orderBy(desc(extractions.documentVersion))
      .limit(1);
    if (!row) return { ...doc, extraction: null };

    // Validate on the way out as well as on the way in (Phát sinh T2.7): jsonb is only "some JSON".
    const data = InvoiceSchema.safeParse(row.data);
    if (!data.success || !Array.isArray(row.warnings)) throw new ExtractionDataInvalidError();
    return {
      ...doc,
      extraction: {
        id: row.id,
        documentVersion: row.documentVersion,
        source: row.source,
        data: data.data,
        warnings: row.warnings as unknown[],
        createdAt: row.createdAt,
      },
    };
  }
}
