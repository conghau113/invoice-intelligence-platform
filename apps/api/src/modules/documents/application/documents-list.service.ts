import { Injectable } from '@nestjs/common';
import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { documents } from '../../../db/schema';
import { TenantDbService, type Db, type Tx } from '../../../db/tenant-db.service';
import { LIST_TIME_ZONE, type DocumentListQuery } from '../domain/document-list-query';

/** One row of the list. No storage key; the content hash is not needed to find a document. */
export interface DocumentListItem {
  id: string;
  status: string;
  sourceType: string;
  version: number;
  createdAt: Date;
}

export interface DocumentPage {
  items: DocumentListItem[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/** Midnight of a calendar day in LIST_TIME_ZONE, as a timestamptz. */
const startOfDay = (day: string | SQL) =>
  sql`(${day}::date)::timestamp AT TIME ZONE ${LIST_TIME_ZONE}`;

@Injectable()
export class DocumentsListService {
  constructor(private readonly tenantDb: TenantDbService) {}

  /**
   * One page and the total. `total` counts the rows that match the filters, after the tenant
   * (RLS scopes both queries to the caller, and the tenant filter is repeated so the planner can
   * use it as an index condition), so it never counts rows the caller cannot see. A page past the
   * end answers no items and the true meta; the caller decides where to go (ADR 0019).
   * Sort always ends with `id`, so equal timestamps cannot swap places between pages.
   */
  async list(tenantId: string, query: DocumentListQuery): Promise<DocumentPage> {
    const tx = this.tenantDb.current();
    // One after the other on the request's connection. They are still two statements under READ
    // COMMITTED, so a row inserted between them can make `total` differ from `items` by one until
    // the next refresh (ADR 0019).
    const items = await this.build(tx, tenantId, query);
    const total = await this.count(tx, tenantId, query);
    return {
      items,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  /** Public so a test can run EXPLAIN on exactly what the service runs. */
  async count(tx: Db | Tx, tenantId: string, q: DocumentListQuery): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(documents)
      .where(and(...this.conditions(tenantId, q)));
    return row?.n ?? 0;
  }

  /** The filters, shared by the page and the count so they can never disagree. */
  conditions(tenantId: string, q: DocumentListQuery): SQL[] {
    const conditions: SQL[] = [eq(documents.tenantId, tenantId)];
    if (q.status !== undefined) conditions.push(eq(documents.status, q.status));
    if (q.type !== undefined) conditions.push(eq(documents.sourceType, q.type));
    if (q.from !== undefined) conditions.push(gte(documents.createdAt, startOfDay(q.from)));
    if (q.to !== undefined) {
      // Exclusive upper bound = midnight after the last day.
      conditions.push(lt(documents.createdAt, sql`${startOfDay(q.to)} + interval '1 day'`));
    }
    return conditions;
  }

  /** The page query itself, public so a test can run EXPLAIN on exactly what the service runs. */
  build(tx: Db | Tx, tenantId: string, q: DocumentListQuery) {
    // The columns are NOT NULL, so NULLS FIRST/LAST changes no result; it is spelled out because
    // the planner uses an index for ORDER BY only when the NULLS placement matches the index's
    // (drizzle creates DESC indexes as DESC NULLS LAST; read backwards that is ASC NULLS FIRST).
    const order =
      q.sort === '-createdAt'
        ? [sql`${documents.createdAt} DESC NULLS LAST`, sql`${documents.id} DESC NULLS LAST`]
        : [sql`${documents.createdAt} ASC NULLS FIRST`, sql`${documents.id} ASC NULLS FIRST`];
    return tx
      .select({
        id: documents.id,
        status: documents.status,
        sourceType: documents.sourceType,
        version: documents.version,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(and(...this.conditions(tenantId, q)))
      .orderBy(...order)
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);
  }
}
