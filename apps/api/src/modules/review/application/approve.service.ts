import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  checkInvoice,
  InvoiceSchema,
  todayInVietnam,
  type Invoice,
  type RuleWarning,
} from 'contracts';
import { and, desc, eq } from 'drizzle-orm';
import { isUuid } from '../../../common/uuid';
import {
  auditLogs,
  extractions,
  fieldCorrections,
  invoiceLines,
  invoices,
} from '../../../db/schema';
import { TenantDbService } from '../../../db/tenant-db.service';
import { DocumentStateMachine } from '../../documents/application/document-state-machine';
import { DocumentNotFoundError } from '../../documents/domain/document-not-found.error';
import { ExtractionDataInvalidError } from '../../extraction/domain/ai-errors';
import { withinApproveLimits } from '../domain/approve-limits';
import { diffInvoice } from '../domain/diff-invoice';
import { ExtractionMissingError, INVOICE_INVALID } from '../domain/review-errors';
import { trustedFieldMeta } from '../domain/trusted-field-meta';

export const DOCUMENT_APPROVED = 'document.approved';

/** Several rows per insert stay below Postgres' limit of 65,535 parameters per statement. */
const INSERT_BATCH = 500;

export interface ApproveInput {
  documentId: string;
  tenantId: string;
  userId: string;
  ip: string | undefined;
  /** The document version the person was looking at (from If-Match). */
  expectedVersion: number;
  body: unknown;
}

export interface ApproveResult {
  id: string;
  status: 'approved';
  version: number;
  invoiceId: string;
  /** How many fields differ from the extraction. */
  corrections: number;
  warnings: RuleWarning[];
}

function batches<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += INSERT_BATCH) out.push(rows.slice(i, i + INSERT_BATCH));
  return out;
}

@Injectable()
export class ApproveService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly machine: DocumentStateMachine,
  ) {}

  /**
   * Runs in the request's tenant transaction: status change, invoice, lines, corrections and audit
   * commit or roll back together. The state machine goes first because it takes the row lock: a
   * second approval waits there, then fails its checks, before anything else is read or written.
   */
  async approve(input: ApproveInput): Promise<ApproveResult> {
    if (!isUuid(input.documentId)) throw new DocumentNotFoundError();
    const parsed = InvoiceSchema.safeParse(input.body);
    if (!parsed.success || !withinApproveLimits(parsed.data)) {
      // Only the code: Zod issues can quote what was sent, and that is document content.
      throw new UnprocessableEntityException({
        message: 'The invoice does not match the schema',
        code: INVOICE_INVALID,
      });
    }
    const invoice = parsed.data;

    const { version } = await this.machine.transition(input.documentId, 'approved', {
      actorId: input.userId,
      expectedVersion: input.expectedVersion,
    });

    const tx = this.tenantDb.current();
    const extraction = await this.latestExtraction(input);
    const warnings = checkInvoice(invoice, todayInVietnam(new Date()));
    const corrections = diffInvoice(extraction.data, invoice);

    const [created] = await tx
      .insert(invoices)
      .values({
        tenantId: input.tenantId,
        documentId: input.documentId,
        documentVersion: version,
        invoiceNo: invoice.invoiceNo,
        series: invoice.series,
        issueDate: invoice.issueDate,
        sellerTaxCode: invoice.seller.taxCode,
        sellerName: invoice.seller.name,
        buyerTaxCode: invoice.buyer.taxCode,
        currency: invoice.currency,
        subtotal: invoice.subtotal,
        vatAmount: invoice.vatBreakdown.reduce((sum, row) => sum + row.amount, 0),
        total: invoice.total,
        data: { ...invoice, fieldMeta: trustedFieldMeta(extraction.data, invoice) },
        warnings,
        approvedBy: input.userId,
      })
      .returning({ id: invoices.id });
    if (!created) throw new Error('Insert returned no invoice');

    const lines = invoice.lines.map((line, i) => ({
      tenantId: input.tenantId,
      invoiceId: created.id,
      lineNo: i + 1,
      description: line.description,
      quantity: String(line.quantity),
      unit: line.unit,
      unitPrice: line.unitPrice,
      vatRate: String(line.vatRate),
      amount: line.amount,
    }));
    for (const batch of batches(lines)) await tx.insert(invoiceLines).values(batch);

    const rows = corrections.map((c) => ({
      tenantId: input.tenantId,
      extractionId: extraction.id,
      documentVersion: version,
      fieldPath: c.fieldPath,
      aiValue: c.aiValue,
      humanValue: c.humanValue,
    }));
    for (const batch of batches(rows)) await tx.insert(fieldCorrections).values(batch);

    // Numbers only (SECURITY.md section 5): the values themselves stay out of the audit log.
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorId: input.userId,
      action: DOCUMENT_APPROVED,
      entity: 'document',
      entityId: input.documentId,
      meta: { version, corrections: corrections.length },
      ip: input.ip,
    });

    return {
      id: input.documentId,
      status: 'approved',
      version,
      invoiceId: created.id,
      corrections: corrections.length,
      warnings,
    };
  }

  /** The base of the diff is what is stored, never something the client sent. */
  private async latestExtraction(input: ApproveInput): Promise<{ id: string; data: Invoice }> {
    const [row] = await this.tenantDb
      .current()
      .select({ id: extractions.id, data: extractions.data })
      .from(extractions)
      .where(
        and(eq(extractions.documentId, input.documentId), eq(extractions.tenantId, input.tenantId)),
      )
      .orderBy(desc(extractions.documentVersion))
      .limit(1);
    if (!row) throw new ExtractionMissingError();
    const data = InvoiceSchema.safeParse(row.data);
    if (!data.success) throw new ExtractionDataInvalidError();
    return { id: row.id, data: data.data };
  }
}
