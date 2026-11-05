import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { InvoiceSchema, RuleWarningSchema, type Invoice, type RuleWarning } from 'contracts';
import { isUuid } from '../../../common/uuid';
import { documents, extractions, invoices } from '../../../db/schema';
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

/** What a person approved: the review screen shows this instead of the AI's values. */
export interface ApprovedInvoiceView {
  id: string;
  documentVersion: number;
  data: Invoice;
  warnings: RuleWarning[];
  approvedAt: Date;
}

/** API.md `GET /documents/:id`: the document, its latest extraction (null until one exists) and approved invoice. */
export interface DocumentDetail {
  id: string;
  status: string;
  sourceType: string;
  version: number;
  createdAt: Date;
  /** Why the document is `failed` (a code the UI translates); null in every other status. */
  failureCode: string | null;
  extraction: ExtractionView | null;
  invoice: ApprovedInvoiceView | null;
}

/**
 * Warnings are advice, not data: an entry that does not match (a row written before T3.3) is left
 * out instead of making the whole page fail.
 */
const readWarnings = (stored: unknown): RuleWarning[] =>
  (Array.isArray(stored) ? stored : []).flatMap((w: unknown) => {
    const parsed = RuleWarningSchema.safeParse(w);
    return parsed.success ? [parsed.data] : [];
  });

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
    const [approved] = await tx
      .select({
        id: invoices.id,
        documentVersion: invoices.documentVersion,
        data: invoices.data,
        warnings: invoices.warnings,
        approvedAt: invoices.approvedAt,
      })
      .from(invoices)
      .where(eq(invoices.documentId, id));

    return {
      ...doc,
      extraction: row ? this.toExtractionView(row) : null,
      invoice: approved ? this.toInvoiceView(approved) : null,
    };
  }

  private toExtractionView(row: typeof extractions.$inferSelect): ExtractionView {
    // Validate on the way out as well as on the way in (Phát sinh T2.7): jsonb is only "some JSON".
    const data = InvoiceSchema.safeParse(row.data);
    if (!data.success) throw new ExtractionDataInvalidError();
    return {
      id: row.id,
      documentVersion: row.documentVersion,
      source: row.source,
      data: data.data,
      warnings: readWarnings(row.warnings),
      createdAt: row.createdAt,
    };
  }

  private toInvoiceView(
    row: Omit<ApprovedInvoiceView, 'data' | 'warnings'> & { data: unknown; warnings: unknown },
  ): ApprovedInvoiceView {
    const data = InvoiceSchema.safeParse(row.data);
    if (!data.success) throw new ExtractionDataInvalidError();
    return { ...row, data: data.data, warnings: readWarnings(row.warnings) };
  }
}
