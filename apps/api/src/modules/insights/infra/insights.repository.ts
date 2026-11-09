import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../../../db/tenant-db.service';
import type { FieldCount } from '../domain/correction-rate';

// Bound as parameters, so no escaping rule of the SQL text applies: `lines.3.amount` -> `lines.*.amount`.
const ROW_INDEX = String.raw`^(lines|vatBreakdown)\.[0-9]+\.`;
const ROW_GROUP = String.raw`\1.*.`;

export interface ApprovedTotals {
  /** AI path (PDF, picture): the denominator of the correction rate. */
  aiDocuments: number;
  xmlDocuments: number;
  /** AI-path documents whose approved version changed at least one field. */
  correctedDocuments: number;
  /**
   * Mean `cost_usd` of the extraction each approved AI document was reviewed against. Documents
   * without a recorded cost are left out of the mean (avg skips NULL), not counted as $0.
   */
  meanCostUsd: number | null;
}

/**
 * Reads what is approved NOW, through the views of migration 0013 and never the history tables:
 * `field_corrections` repeats a change at every re-approval and still holds the rows of a document
 * that is open again (T3.8). Runs in the request's tenant transaction (RLS; the views are
 * security_invoker), and repeats the tenant filter as defence in depth. Only counts leave the
 * database, never a value.
 */
@Injectable()
export class InsightsRepository {
  constructor(private readonly tenantDb: TenantDbService) {}

  async approvedTotals(tenantId: string): Promise<ApprovedTotals> {
    const result = await this.tenantDb.current().execute<{
      ai: number;
      xml: number;
      corrected: number;
      cost: string | null;
    }>(sql`
      SELECT count(*) FILTER (WHERE d.source_type IN ('pdf', 'image'))::int AS ai,
             count(*) FILTER (WHERE d.source_type = 'xml')::int AS xml,
             count(*) FILTER (WHERE d.source_type IN ('pdf', 'image') AND EXISTS (
               SELECT 1 FROM current_field_corrections c
                WHERE c.document_id = d.id AND c.tenant_id = d.tenant_id))::int AS corrected,
             avg(e.cost_usd) FILTER (WHERE d.source_type IN ('pdf', 'image')) AS cost
        FROM current_invoices ci
        JOIN documents d ON d.id = ci.document_id AND d.tenant_id = ci.tenant_id
        -- Approval diffs against the newest extraction of the document (ApproveService).
        LEFT JOIN LATERAL (
          SELECT x.cost_usd FROM extractions x
           WHERE x.document_id = d.id AND x.tenant_id = d.tenant_id
           ORDER BY x.document_version DESC LIMIT 1
        ) e ON true
       WHERE ci.tenant_id = ${tenantId}`);
    const row = result.rows[0];
    return {
      aiDocuments: row?.ai ?? 0,
      xmlDocuments: row?.xml ?? 0,
      correctedDocuments: row?.corrected ?? 0,
      // numeric arrives as a string; a mean of list-price estimates fits a double.
      meanCostUsd: row?.cost == null ? null : Number(row.cost),
    };
  }

  /**
   * Documents per corrected field, AI path only. `lines.3.amount` is grouped as `lines.*.amount`
   * and a document counts once per group (see correctionRate).
   */
  async correctedFields(tenantId: string): Promise<FieldCount[]> {
    const result = await this.tenantDb.current().execute<{ field: string; documents: number }>(sql`
      SELECT regexp_replace(c.field_path, ${ROW_INDEX}, ${ROW_GROUP}) AS field,
             count(DISTINCT c.document_id)::int AS documents
        FROM current_field_corrections c
        JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
        -- Same population as the denominator (approvedTotals), so a rate can never exceed 1.
        JOIN current_invoices ci ON ci.document_id = d.id AND ci.tenant_id = d.tenant_id
       WHERE c.tenant_id = ${tenantId} AND d.source_type IN ('pdf', 'image')
       GROUP BY 1`);
    return result.rows;
  }
}
