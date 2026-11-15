import { Injectable } from '@nestjs/common';
import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { documents } from '../../../db/schema';
import { TenantDbService, type Db, type Tx } from '../../../db/tenant-db.service';
import { TenantReadCache } from '../../cache/application/tenant-read-cache';
import { DOCUMENT_STATUSES } from '../domain/document-status';
import { SOURCE_TYPES } from '../domain/file-type';
import { LIST_TIME_ZONE, MAX_LIMIT, type DocumentListQuery } from '../domain/document-list-query';

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

/**
 * A page as it comes back from the cache (JSON: dates are strings). Stricter than the type so a
 * value that is not a page (an old format, a corrupted entry) is a miss, not a wrong answer.
 */
const cachedPageSchema: z.ZodType<DocumentPage> = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        status: z.enum(DOCUMENT_STATUSES),
        sourceType: z.enum(SOURCE_TYPES),
        version: z.int().min(1),
        createdAt: z.iso.datetime().transform((v) => new Date(v)),
      }),
    )
    .max(MAX_LIMIT),
  meta: z.strictObject({
    page: z.int().min(1),
    limit: z.int().min(1),
    total: z.int().min(0),
    totalPages: z.int().min(0),
  }),
});

/** Short: a status bump that failed to reach Redis is visible for this long at most (ADR 0013). */
export const LIST_CACHE_TTL_MS = 30_000;

/** Midnight of a calendar day in LIST_TIME_ZONE, as a timestamptz. */
const startOfDay = (day: string | SQL) =>
  sql`(${day}::date)::timestamp AT TIME ZONE ${LIST_TIME_ZONE}`;

@Injectable()
export class DocumentsListService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly cache: TenantReadCache,
  ) {}

  /**
   * Cache-aside (T6.3): the same page of the same filters, until a document of the tenant changes
   * (DocumentStateMachine and the upload bump the tenant's generation after COMMIT) or for
   * LIST_CACHE_TTL_MS. The key holds the tenant and every query field.
   */
  list(tenantId: string, query: DocumentListQuery): Promise<DocumentPage> {
    return this.cache.read(
      {
        tenantId,
        name: 'documents-list',
        params: { ...query },
        schema: cachedPageSchema,
        ttlMs: LIST_CACHE_TTL_MS,
      },
      () => this.load(tenantId, query),
    );
  }

  /**
   * One page and the total. `total` counts the rows that match the filters, after the tenant
   * (RLS scopes both queries to the caller, and the tenant filter is repeated so the planner can
   * use it as an index condition), so it never counts rows the caller cannot see. A page past the
   * end answers no items and the true meta; the caller decides where to go (ADR 0019).
   * Sort always ends with `id`, so equal timestamps cannot swap places between pages.
   */
  async load(tenantId: string, query: DocumentListQuery): Promise<DocumentPage> {
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
