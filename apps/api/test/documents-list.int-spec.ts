/**
 * GET /documents end to end: real guards, real service, Postgres as the app role (RLS on). Proves
 * the pagination is lossless and counts correctly, the filters and the time zone boundary are right, tenants are
 * isolated, and the query uses the indexes of migration 0007 (spec T2.6: 1.000 rows, EXPLAIN).
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { and, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { ProblemDetailsFilter } from '../src/common/http/problem-details.filter';
import * as schema from '../src/db/schema';
import { seedDocuments } from '../src/db/seed-documents';
import { DB, TenantDbService, type Db } from '../src/db/tenant-db.service';
import { TenantTransactionInterceptor } from '../src/db/tenant-transaction.interceptor';
import { TENANT_DIRECTORY } from '../src/modules/auth/application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../src/modules/auth/application/token-verifier.port';
import { JwtAuthGuard } from '../src/modules/auth/http/jwt-auth.guard';
import { PermissionsGuard } from '../src/modules/auth/http/permissions.guard';
import { DocumentsListService } from '../src/modules/documents/application/documents-list.service';
import { parseDocumentListQuery } from '../src/modules/documents/domain/document-list-query';
import { DocumentsModule } from '../src/modules/documents/documents.module';
import { EXTRACTION_QUEUE_PORT } from '../src/modules/queue/application/extraction-queue.port';
import { FakeExtractionQueue } from '../src/modules/queue/testing/fake-extraction-queue';
import { STORAGE_PORT } from '../src/modules/storage/application/storage.port';
import { LocalFsStorage } from '../src/modules/storage/infra/local-fs.storage';
import { useTestRoots } from '../src/modules/storage/testing/test-root';

const TENANTS = {
  acme: '00000000-0000-4000-8000-0000000000a1',
  globex: '00000000-0000-4000-8000-0000000000a2',
} as const;
const SEEDED = 1000;
const HASH = (n: number) => n.toString(16).padStart(64, '0');
const newRoot = useTestRoots();

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

interface Item {
  id: string;
  status: string;
  sourceType: string;
  createdAt: string;
}
interface Page {
  items: Item[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

describe('GET /documents (HTTP -> Postgres, RLS on)', () => {
  let owner: Pool;
  let pool: Pool;
  let app: INestApplication;
  let lists: DocumentsListService;

  // The token is "<role>@<alias>": the stubs below turn it into claims.
  const get = (qs = '', token = 'viewer@acme') =>
    request(app.getHttpServer()).get(`/documents${qs}`).set('Authorization', `Bearer ${token}`);

  /** Every page in turn, following meta.totalPages. */
  async function walk(qs: string, token = 'viewer@acme'): Promise<Item[]> {
    const all: Item[] = [];
    const sep = qs === '' ? '?' : '&';
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page++) {
      const res = await get(`${qs}${sep}page=${page}`, token).expect(200);
      const body = res.body as Page;
      all.push(...body.items);
      totalPages = body.meta.totalPages;
    }
    return all;
  }

  const insert = (tenant: string, n: number, createdAt: string) =>
    owner.query(
      `INSERT INTO documents (tenant_id, source_type, storage_key, content_hash, uploaded_by, created_at)
       VALUES ($1, 'xml', $2, $3, '00000000-0000-4000-8000-00000000f0fe', $4)`,
      [tenant, `tenant/${tenant}/edge-${n}`, HASH(n), createdAt],
    );
  const clean = () => owner.query('DELETE FROM documents');

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 2 });
    pool = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 4 });
    const root = await newRoot();

    @Global()
    @Module({
      providers: [
        { provide: DB, useValue: drizzle(pool, { schema }) },
        TenantDbService,
        { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
      ],
      exports: [DB, TenantDbService],
    })
    class RealDbModule {}

    const mod = await Test.createTestingModule({
      imports: [RealDbModule, DocumentsModule],
      providers: [
        {
          provide: TOKEN_VERIFIER,
          useValue: {
            verify: (token: string) => {
              const [role, alias] = token.split('@');
              return Promise.resolve({
                sub: '00000000-0000-4000-8000-00000000f004',
                organization: [alias],
                realm_access: { roles: [role] },
              });
            },
          },
        },
        {
          provide: TENANT_DIRECTORY,
          useValue: {
            idForAlias: (alias: keyof typeof TENANTS) => Promise.resolve(TENANTS[alias]),
          },
        },
        { provide: ConfigService, useValue: {} },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    })
      .overrideProvider(STORAGE_PORT)
      .useValue(new LocalFsStorage(root))
      .overrideProvider(EXTRACTION_QUEUE_PORT)
      .useValue(new FakeExtractionQueue())
      .compile();
    app = mod.createNestApplication();
    await app.init();
    lists = app.get(DocumentsListService);

    await clean();
    await seedDocuments(owner, TENANTS.acme, SEEDED, 'int');
    await seedDocuments(owner, TENANTS.globex, 300, 'int');
    await owner.query('ANALYZE documents');
  }, 60000);

  afterAll(async () => {
    await app.close();
    await clean();
    await Promise.all([owner.end(), pool.end()]);
  });

  describe('pagination', () => {
    it.each(['-createdAt', 'createdAt'])(
      'sort=%s: every row once, in order, across pages of 100',
      async (sort) => {
        const items = await walk(`?limit=100&sort=${sort}`);
        const { rows } = await owner.query<{ id: string }>(
          `SELECT id FROM documents WHERE tenant_id = $1
            ORDER BY created_at ${sort.startsWith('-') ? 'DESC' : 'ASC'}, id ${sort.startsWith('-') ? 'DESC' : 'ASC'}`,
          [TENANTS.acme],
        );
        expect(items).toHaveLength(SEEDED);
        expect(items.map((i) => i.id)).toEqual(rows.map((r) => r.id));
      },
    );

    it('meta tells the total, the page count and where we are', async () => {
      const second = (await get('?limit=20&page=2').expect(200)).body as Page;
      expect(second.meta).toEqual({ page: 2, limit: 20, total: SEEDED, totalPages: 50 });
      expect(second.items).toHaveLength(20);
      const odd = (await get('?limit=30&page=34').expect(200)).body as Page;
      expect(odd.meta).toEqual({ page: 34, limit: 30, total: SEEDED, totalPages: 34 });
      expect(odd.items).toHaveLength(SEEDED - 33 * 30); // the short last page
    });

    it('any page can be asked for directly, not only in order', async () => {
      const all = await walk('?limit=10');
      const jump = (await get('?limit=10&page=42').expect(200)).body as Page;
      expect(jump.items.map((i) => i.id)).toEqual(all.slice(410, 420).map((i) => i.id));
    });

    it('a page past the end answers no items and the true meta', async () => {
      const res = (await get('?limit=20&page=51').expect(200)).body as Page;
      expect(res.items).toEqual([]);
      expect(res.meta).toEqual({ page: 51, limit: 20, total: SEEDED, totalPages: 50 });
    });

    it('rows with the same timestamp are neither repeated nor skipped', async () => {
      await clean();
      const same = '2026-03-01T10:00:00.123456Z';
      for (let n = 1; n <= 5; n++) await insert(TENANTS.acme, n, same);
      const items = await walk('?limit=2');
      expect(new Set(items.map((i) => i.id)).size).toBe(5);
      expect(items).toHaveLength(5);
    });

    it.each(['-createdAt', 'createdAt'] as const)(
      'sort=%s always ends with id, so equal timestamps cannot swap between pages',
      (sort) => {
        // With an index the rows of a tie already come out in id order, so no data test can see a
        // missing tie-break; the statement itself is what has to carry it (it matters the day the
        // planner picks a scan plus a sort).
        const { sql } = lists
          .build(drizzle(pool, { schema }), TENANTS.acme, parseDocumentListQuery({ sort }))
          .toSQL();
        expect(sql).toMatch(
          /order by "documents"\."created_at" (DESC NULLS LAST|ASC NULLS FIRST), "documents"\."id" (DESC NULLS LAST|ASC NULLS FIRST)/i,
        );
      },
    );

    it('an empty tenant has total 0 and 0 pages', async () => {
      await clean();
      const res = (await get('').expect(200)).body as Page;
      expect(res).toEqual({ items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    });
  });

  describe('filters', () => {
    beforeAll(async () => {
      await clean();
      await seedDocuments(owner, TENANTS.acme, SEEDED, 'int');
      await seedDocuments(owner, TENANTS.globex, 300, 'int');
      await owner.query('ANALYZE documents');
    }, 60000);

    it('status and type', async () => {
      const items = await walk('?status=failed&type=pdf&limit=50');
      const { rows } = await owner.query(
        `SELECT 1 FROM documents WHERE tenant_id = $1 AND status = 'failed' AND source_type = 'pdf'`,
        [TENANTS.acme],
      );
      expect(items.length).toBeGreaterThan(0);
      expect(items).toHaveLength(rows.length);
      const first = (await get('?status=failed&type=pdf&limit=50').expect(200)).body as Page;
      expect(first.meta.total).toBe(rows.length); // the total follows the filters
      expect(items.every((i) => i.status === 'failed' && i.sourceType === 'pdf')).toBe(true);
    });

    it('from/to are whole days in Asia/Ho_Chi_Minh', async () => {
      await clean();
      // 23:30 UTC on 1 March is 06:30 on 2 March in Vietnam (UTC+7).
      await insert(TENANTS.acme, 1, '2026-03-01T23:30:00Z');
      await insert(TENANTS.acme, 2, '2026-03-02T16:59:00Z'); // 23:59 on 2 March in Vietnam
      await insert(TENANTS.acme, 3, '2026-03-02T17:01:00Z'); // 00:01 on 3 March in Vietnam
      const day = async (qs: string) =>
        (await get(qs).expect(200)).body.items.map((i: Item) => i.createdAt);
      expect(await day('?from=2026-03-02&to=2026-03-02&sort=createdAt')).toEqual([
        '2026-03-01T23:30:00.000Z',
        '2026-03-02T16:59:00.000Z',
      ]);
      expect(await day('?from=2026-03-03&to=2026-03-03')).toEqual(['2026-03-02T17:01:00.000Z']);
      expect(await day('?to=2026-03-01')).toEqual([]);
    });

    it('answers 400 with a code for a bad query, without echoing it', async () => {
      const bad = await get('?status=nope').expect(400);
      expect(bad.body.code).toBe('INVALID_QUERY');
      for (const qs of ['?page=0', '?page=10001', '?limit=101', '?page=last', '?cursor=abc']) {
        expect((await get(qs).expect(400)).body.code).toBe('INVALID_QUERY');
      }
      expect(JSON.stringify(bad.body)).not.toMatch(/nope/);
    });
  });

  describe('isolation and permission', () => {
    beforeAll(async () => {
      await clean();
      await seedDocuments(owner, TENANTS.acme, SEEDED, 'int');
      await seedDocuments(owner, TENANTS.globex, 300, 'int');
    }, 60000);

    it('a tenant sees only its own rows, and its total counts only those', async () => {
      const mine = await walk('?limit=100', 'viewer@globex');
      const { rows } = await owner.query<{ id: string }>(
        'SELECT id FROM documents WHERE tenant_id = $1',
        [TENANTS.globex],
      );
      expect(new Set(mine.map((i) => i.id))).toEqual(new Set(rows.map((r) => r.id)));
      const page = (await get('?limit=100', 'viewer@globex').expect(200)).body as Page;
      expect(page.meta.total).toBe(300); // not 1.300: acme's rows are not counted
      const acme = (await get('?limit=100').expect(200)).body as Page;
      expect(acme.meta.total).toBe(SEEDED);
    });

    it('a user without document:read gets 403', async () => {
      await get('', 'nobody@acme').expect(403);
    });
  });

  describe('query plan and speed (1.000 rows)', () => {
    const explain = async (
      pick: (tx: Db) => {
        toSQL(): { sql: string; params: unknown[] };
      },
    ) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANTS.acme]);
        // The builder only needs a drizzle handle on this client to produce SQL; it never runs through it.
        const { sql, params } = pick(drizzle(client, { schema }) as unknown as Db).toSQL();
        const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
        await client.query('ROLLBACK');
        return rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
      } finally {
        client.release();
      }
    };
    const plans = (qs: Record<string, string>) =>
      explain((tx) => lists.build(tx, TENANTS.acme, parseDocumentListQuery(qs)));

    beforeAll(async () => {
      await clean();
      await seedDocuments(owner, TENANTS.acme, SEEDED, 'int');
      await seedDocuments(owner, TENANTS.globex, 300, 'int');
      await owner.query('ANALYZE documents');
    }, 60000);

    it.each([
      ['no filter, newest first', {}, 'documents_tenant_created_idx'],
      ['no filter, oldest first', { sort: 'createdAt' }, 'documents_tenant_created_idx'],
      ['status filter', { status: 'needs_review' }, 'documents_tenant_status_created_idx'],
      ['page 5', { page: '5', limit: '20' }, 'documents_tenant_created_idx'],
    ])('%s uses an index and no sort step', async (_name, qs, index) => {
      const plan = await plans(qs);
      console.log(`EXPLAIN ${_name}:\n${plan}`);
      expect(plan).toContain(index);
      expect(plan).not.toMatch(/Seq Scan on documents/);
      expect(plan).not.toMatch(/\bSort\b/);
    });

    it('a filtered count uses the status index; the whole-tenant count is a cheap scan at this size', async () => {
      const filtered = await explain((tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.documents)
          .where(
            and(...lists.conditions(TENANTS.acme, parseDocumentListQuery({ status: 'failed' }))),
          ),
      );
      console.log(`EXPLAIN count status=failed:\n${filtered}`);
      expect(filtered).toMatch(/Index (Only )?Scan using documents_tenant_status_created_idx/);

      // 1.000 of the 1.300 rows are acme's: reading the table once is cheaper than the index
      // here, and the planner is right. The count is O(rows that match); ADR 0019 names the
      // size at which this is revisited.
      const all = await explain((tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.documents)
          .where(and(...lists.conditions(TENANTS.acme, parseDocumentListQuery({})))),
      );
      console.log(`EXPLAIN count (no filter):\n${all}`);
      expect(all).toMatch(/Execution Time: [0-4]\.\d+ ms/);
    });

    it('a deep page still answers fast (the planner may scan the table: offset 780 of 1.000)', async () => {
      const plan = await plans({ page: '40', limit: '20' });
      console.log(`EXPLAIN page 40:\n${plan}`);
      expect(plan).toMatch(/Execution Time: [0-9]\.\d+ ms/);
    });

    it('first page timing over 20 runs (logged, not asserted: timing is flaky in CI)', async () => {
      const ms: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = process.hrtime.bigint();
        await get('?limit=20').expect(200);
        ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      ms.sort((a, b) => a - b);
      console.log(
        `GET /documents first page + total, ${SEEDED} rows: median ${ms.at(9)?.toFixed(1)} ms, p95 ${ms.at(18)?.toFixed(1)} ms, max ${ms.at(19)?.toFixed(1)} ms`,
      );
    });
  });
});
