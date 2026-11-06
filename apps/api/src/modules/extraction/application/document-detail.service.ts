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

type StoredInvoice = Omit<ApprovedInvoiceView, 'data' | 'warnings'> & {
  data: unknown;
  warnings: unknown;
};

/**
 * API.md `GET /documents/:id`: the document, its latest extraction (null until one exists), and
 * either the invoice approved at the current version or, after a reopen, the one it was reopened
 * from. Never both: a reopened invoice is not approved, but the form starts from its values.
 */
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
  reopenedFrom: ApprovedInvoiceView | null;
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
      .where(eq(invoices.documentId, id))
      .orderBy(desc(invoices.documentVersion))
      .limit(1);
    // A row exists at version N only if version N was approved, and reopening always moves on.
    const current = approved?.documentVersion === doc.version;

    return {
      ...doc,
      extraction: row ? this.toExtractionView(row) : null,
      invoice: approved && current ? this.toInvoiceView(approved) : null,
      reopenedFrom: approved && !current ? this.toReopenedView(approved) : null,
    };
  }

  /**
   * Only a starting point for the form, unlike the current invoice. If an older row no longer passes
   * the schema (it was tightened since), the form falls back to the extraction: failing here would
   * leave a reopened document that nobody can open or approve again.
   */
  private toReopenedView(row: StoredInvoice): ApprovedInvoiceView | null {
    const data = InvoiceSchema.safeParse(row.data);
    return data.success ? { ...row, data: data.data, warnings: readWarnings(row.warnings) } : null;
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

  private toInvoiceView(row: StoredInvoice): ApprovedInvoiceView {
    const data = InvoiceSchema.safeParse(row.data);
    if (!data.success) throw new ExtractionDataInvalidError();
    return { ...row, data: data.data, warnings: readWarnings(row.warnings) };
  }
}
