import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { InvoiceSchema, RuleWarningSchema, type Invoice, type RuleWarning } from 'contracts';
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
  warnings: RuleWarning[];
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
    if (!data.success) throw new ExtractionDataInvalidError();
    // Warnings are advice, not data: an entry that does not match (a row written before T3.3)
    // is left out instead of making the whole page fail.
    const warnings = (Array.isArray(row.warnings) ? row.warnings : []).flatMap((w: unknown) => {
      const parsed = RuleWarningSchema.safeParse(w);
      return parsed.success ? [parsed.data] : [];
    });
    return {
      ...doc,
      extraction: {
        id: row.id,
        documentVersion: row.documentVersion,
        source: row.source,
        data: data.data,
        warnings,
        createdAt: row.createdAt,
      },
    };
  }
}
