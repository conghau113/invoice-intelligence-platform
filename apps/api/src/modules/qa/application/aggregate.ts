import type { QaAggregateFilter, QaCitation } from 'contracts';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../../../db/tenant-db.service';
import { containsPattern } from '../domain/like';

/** Invoices listed as sources of an aggregate; `invoiceCount` still counts all of them. */
export const MAX_AGGREGATE_CITATIONS = 50;
/** Suppliers listed with an aggregate; `sellerCount` still counts all of them. */
export const MAX_AGGREGATE_SELLERS = 20;

export type AggregateOutcome = {
  /** One sum per currency in minor units, by currency code; empty for `invoiceCount`. */
  results: { currency: string; amount: number }[];
  invoiceCount: number;
  /** Suppliers whose invoices were added up, by name (at most MAX_AGGREGATE_SELLERS). */
  sellers: { name: string; taxCode: string }[];
  sellerCount: number;
  /** The first MAX_AGGREGATE_CITATIONS invoices that were counted, oldest first. */
  citations: QaCitation[];
};

type TotalRow = { currency: string; invoices: number; amount: string | null };
type SellerRow = { name: string; tax_code: string; total: number };
type SourceRow = {
  id: string;
  document_id: string;
  document_version: number;
  field_meta: unknown;
  vat_rows: number | null;
  line_nos: number[] | null;
};

/**
 * The number tool of Q&A (T5.4). The model never writes SQL: it fills `QaAggregateFilter`, and this
 * function owns the query. Model values only ever become bound parameters; which column is summed
 * comes from a fixed map keyed by the validated `metric` enum. The sum is computed by Postgres, not
 * by the model.
 *
 * Reads the views `current_invoices` and `current_invoice_lines` only: `invoices` keeps every
 * approved version and the invoices of reopened documents (T3.8), so summing the table would count
 * an invoice twice and include what is no longer approved (DATA_MODEL.md). The tenant is filtered
 * here as well as by RLS (ADR 0003, defense in depth). Runs inside the caller's tenant transaction.
 */
export async function runAggregate(
  tx: Tx,
  tenantId: string,
  filter: QaAggregateFilter,
): Promise<AggregateOutcome> {
  const byLine = filter.itemDescription !== null;
  const from = byLine
    ? sql`current_invoice_lines l
          JOIN current_invoices i ON i.id = l.invoice_id AND i.tenant_id = l.tenant_id`
    : sql`current_invoices i`;
  const where = conditions(tenantId, filter);

  const summed = summedColumn(filter.metric);
  const { rows: totals } = await tx.execute<TotalRow>(sql`
    SELECT i.currency, count(DISTINCT i.id)::int AS invoices, sum(${summed})::text AS amount
      FROM ${from}
     WHERE ${where}
     GROUP BY i.currency
     ORDER BY i.currency`);
  // An invoice has one currency, so the per-currency counts add up to distinct invoices.
  const invoiceCount = totals.reduce((n, t) => n + t.invoices, 0);
  if (invoiceCount === 0) {
    return { results: [], invoiceCount: 0, sellers: [], sellerCount: 0, citations: [] };
  }

  // A supplier filter is "contains": show who was actually added up (code review, T5.4).
  const { rows: sellers } = await tx.execute<SellerRow>(sql`
    SELECT i.seller_name AS name, i.seller_tax_code AS tax_code, count(*) OVER ()::int AS total
      FROM ${from}
     WHERE ${where}
     GROUP BY i.seller_name, i.seller_tax_code
     ORDER BY i.seller_name, i.seller_tax_code
     LIMIT ${MAX_AGGREGATE_SELLERS}`);

  const { rows: sources } = await tx.execute<SourceRow>(
    byLine
      ? sql`
        SELECT i.id, i.document_id, i.document_version, i.data->'fieldMeta' AS field_meta,
               NULL::int AS vat_rows, array_agg(l.line_no ORDER BY l.line_no) AS line_nos
          FROM ${from}
         WHERE ${where}
         GROUP BY i.id, i.document_id, i.document_version, i.issue_date, i.data->'fieldMeta'
         ORDER BY i.issue_date, i.id
         LIMIT ${MAX_AGGREGATE_CITATIONS}`
      : sql`
        SELECT i.id, i.document_id, i.document_version, i.data->'fieldMeta' AS field_meta,
               jsonb_array_length(i.data->'vatBreakdown') AS vat_rows, NULL::int[] AS line_nos
          FROM ${from}
         WHERE ${where}
         ORDER BY i.issue_date, i.id
         LIMIT ${MAX_AGGREGATE_CITATIONS}`,
  );

  return {
    results:
      filter.metric === 'invoiceCount'
        ? []
        : totals.map((t) => ({ currency: t.currency, amount: toSafeInteger(t.amount) })),
    invoiceCount,
    sellers: sellers.map((r) => ({ name: r.name, taxCode: r.tax_code })),
    sellerCount: sellers[0]?.total ?? 0,
    citations: sources.map((s, i) => {
      const paths = fieldPaths(filter.metric, s);
      return {
        n: i + 1,
        documentId: s.document_id,
        documentVersion: s.document_version,
        invoiceId: s.id,
        chunkId: null,
        refs: paths.map((p) => ({
          document_id: s.document_id,
          field_path: p,
          page: pageOf(s.field_meta, p),
        })),
      };
    }),
  };
}

function conditions(tenantId: string, f: QaAggregateFilter): SQL {
  const parts: SQL[] = [sql`i.tenant_id = ${tenantId}`];
  if (f.itemDescription !== null) {
    parts.push(sql`l.tenant_id = ${tenantId}`);
    parts.push(sql`l.description ILIKE ${containsPattern(f.itemDescription)} ESCAPE '\\'`);
  }
  if (f.sellerName !== null) {
    parts.push(sql`i.seller_name ILIKE ${containsPattern(f.sellerName)} ESCAPE '\\'`);
  }
  if (f.sellerTaxCode !== null) parts.push(sql`i.seller_tax_code = ${f.sellerTaxCode}`);
  if (f.issueDateFrom !== null) parts.push(sql`i.issue_date >= ${f.issueDateFrom}::date`);
  if (f.issueDateTo !== null) parts.push(sql`i.issue_date <= ${f.issueDateTo}::date`);
  if (f.currency !== null) parts.push(sql`i.currency = ${f.currency}`);
  return sql.join(parts, sql` AND `);
}

/** Fixed SQL per metric: the only place a column is chosen, and never from the model's text. */
function summedColumn(metric: QaAggregateFilter['metric']): SQL {
  switch (metric) {
    case 'total':
      return sql`i.total`;
    case 'subtotal':
      return sql`i.subtotal`;
    case 'vatAmount':
      return sql`i.vat_amount`;
    case 'lineAmount':
      return sql`l.amount`;
    case 'invoiceCount':
      return sql`NULL::bigint`;
  }
}

/** The fields that make up the number, so the web can open the invoice on them (T5.5). */
function fieldPaths(metric: QaAggregateFilter['metric'], s: SourceRow): string[] {
  if (s.line_nos !== null) {
    const column = metric === 'lineAmount' ? 'amount' : 'description';
    return s.line_nos.map((no) => `lines.${no - 1}.${column}`);
  }
  switch (metric) {
    case 'total':
    case 'subtotal':
      return [metric];
    case 'vatAmount':
      return Array.from({ length: s.vat_rows ?? 0 }, (_, k) => `vatBreakdown.${k}.amount`);
    default:
      return ['invoiceNo'];
  }
}

/** Page of a field from the approved invoice's `fieldMeta` (null for XML or when unknown). */
function pageOf(fieldMeta: unknown, path: string): number | null {
  if (typeof fieldMeta !== 'object' || fieldMeta === null) return null;
  const meta = (fieldMeta as Record<string, unknown>)[path];
  if (typeof meta !== 'object' || meta === null) return null;
  const evidence = (meta as { evidence?: unknown }).evidence;
  if (typeof evidence !== 'object' || evidence === null) return null;
  const page = (evidence as { page?: unknown }).page;
  return Number.isSafeInteger(page) && (page as number) >= 1 ? (page as number) : null;
}

/** `sum(bigint)` is numeric, read as text: refuse a value a JS number would round. */
function toSafeInteger(text: string | null): number {
  const value = BigInt(text ?? '0');
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Aggregate is outside the safe integer range');
  }
  return Number(value);
}
