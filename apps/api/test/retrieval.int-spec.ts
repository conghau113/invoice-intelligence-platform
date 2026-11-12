/**
 * T5.3 on a real Postgres (Testcontainers) as the app role under RLS: hybrid retrieval (HNSW vector
 * + full-text, fused with RRF), what it must never return (another tenant, a reopened or
 * unapproved document, an old version, a vector of another model), the HNSW plan and the internal
 * debug route. Ends with the golden set of the spec ("Xong khi"): hit@5 over the chunks of the 100
 * `core` invoices of eval/datasets/v1, per list and fused.
 *
 * The AI service is replaced by a word-hashing embedder (no network). To measure with real vectors,
 * point RETRIEVAL_GOLDEN_VECTORS at a JSON file `{model, chunks: {"<datasetId>#<ordinal>": number[]},
 * questions: {"<id>": number[]}}` made beforehand; the test only reads it and never calls a model.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { applyJsonBodyLimit } from '../src/common/http/json-body-limit';
import { ProblemDetailsFilter } from '../src/common/http/problem-details.filter';
import * as schema from '../src/db/schema';
import { DB, TenantDbService } from '../src/db/tenant-db.service';
import { TenantTransactionInterceptor } from '../src/db/tenant-transaction.interceptor';
import { TENANT_DIRECTORY } from '../src/modules/auth/application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../src/modules/auth/application/token-verifier.port';
import { JwtAuthGuard } from '../src/modules/auth/http/jwt-auth.guard';
import { PermissionsGuard } from '../src/modules/auth/http/permissions.guard';
import { QUERY_EMBEDDER } from '../src/modules/search/application/query-embedder.port';
import {
  fullTextCandidates,
  hnswSettings,
  RetrievalService,
  vectorCandidates,
  vectorSql,
} from '../src/modules/search/application/retrieval';
import { RetrievalModule } from '../src/modules/search/retrieval.module';
import {
  FakeQueryEmbedder,
  WORD_HASH_MODEL,
  wordHashVector,
} from '../src/modules/search/testing/fake-query-embedder';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
/** Uploader of every row this file writes, so cleanup touches nothing else. */
const USER = '00000000-0000-4000-8000-00000000f053';
const ENV = { RAG_TOP_K: 5, RAG_CANDIDATES: 20, NODE_ENV: 'test' };

type ChunkSpec = {
  content: string;
  kind?: 'header' | 'lines';
  ordinal?: number;
  /** Version written on the chunk; defaults to the document's. */
  version?: number;
  model?: string;
  vector?: number[];
};
type DocSpec = {
  /** Fixed ids (document, then chunk i) instead of random ones: ties are broken by id. */
  idsFrom?: string;
  tenant?: string;
  status?: string;
  version?: number;
  chunks: ChunkSpec[];
};

/** A UUID derived from `name`: same name, same id, so the order of tied scores is reproducible. */
function uuidFrom(name: string): string {
  const h = createHash('sha256').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

describe('Hybrid retrieval (T5.3)', () => {
  let owner: Pool;
  let pool: Pool;
  let app: NestExpressApplication;
  let tenantDb: TenantDbService;
  let retrieval: RetrievalService;
  let embedder: FakeQueryEmbedder;

  /**
   * One document with an invoice row for every version it was approved at, and its chunks. Written
   * as the owner, which RLS does not stop here (it is the container's superuser).
   */
  async function addDoc({
    idsFrom,
    tenant = ACME,
    status = 'approved',
    version = 1,
    chunks,
  }: DocSpec) {
    const documentId = idsFrom ? uuidFrom(`${idsFrom}/document`) : randomUUID();
    await owner.query(
      `INSERT INTO documents (id, tenant_id, status, source_type, storage_key, content_hash, version, uploaded_by)
       VALUES ($1, $2, $3, 'xml', $4, $5, $6, $7)`,
      [
        documentId,
        tenant,
        status,
        `tenant/${tenant}/${documentId}`,
        randomBytes(32).toString('hex'),
        version,
        USER,
      ],
    );
    const invoiceIds = new Map<number, string>();
    const invoiceFor = async (v: number): Promise<string> => {
      const known = invoiceIds.get(v);
      if (known) return known;
      const id = randomUUID();
      await owner.query(
        `INSERT INTO invoices (id, tenant_id, document_id, document_version, invoice_no, series, issue_date,
                               seller_tax_code, seller_name, currency, subtotal, vat_amount, total, data, approved_by)
         VALUES ($1, $2, $3, $4, 'SAMPLE', 'C26T', '2026-01-01', '0000000000', 'SAMPLE', 'VND', 0, 0, 0, '{}', $5)`,
        [id, tenant, documentId, v, USER],
      );
      invoiceIds.set(v, id);
      return id;
    };
    const chunkIds: string[] = [];
    for (const [i, c] of chunks.entries()) {
      const v = c.version ?? version;
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO chunks (id, tenant_id, document_id, document_version, invoice_id, kind, ordinal,
                             content, embedding, embedding_model, refs)
         VALUES ($11, $1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10) RETURNING id`,
        [
          tenant,
          documentId,
          v,
          await invoiceFor(v),
          c.kind ?? (i === 0 ? 'header' : 'lines'),
          c.ordinal ?? i,
          c.content,
          JSON.stringify(c.vector ?? wordHashVector(c.content)),
          c.model ?? WORD_HASH_MODEL,
          JSON.stringify([{ document_id: documentId, field_path: 'invoiceNo', page: null }]),
          idsFrom ? uuidFrom(`${idsFrom}/chunk/${i}`) : randomUUID(),
        ],
      );
      chunkIds.push(rows[0]!.id);
    }
    return { documentId, chunkIds };
  }

  async function cleanup(): Promise<void> {
    const mine = `SELECT id FROM documents WHERE uploaded_by = $1`;
    await owner.query(`DELETE FROM chunks WHERE document_id IN (${mine})`, [USER]);
    await owner.query(`DELETE FROM invoices WHERE document_id IN (${mine})`, [USER]);
    await owner.query(`DELETE FROM documents WHERE uploaded_by = $1`, [USER]);
  }

  const docsOf = (chunks: { documentId: string }[]) => [
    ...new Set(chunks.map((c) => c.documentId)),
  ];

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 2 });
    pool = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 6 });

    @Global()
    @Module({
      providers: [
        { provide: DB, useValue: drizzle(pool, { schema }) },
        TenantDbService,
        { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (ENV as Record<string, unknown>)[k] },
        },
      ],
      exports: [DB, TenantDbService, ConfigService],
    })
    class RealDbModule {}

    embedder = new FakeQueryEmbedder();
    const mod = await Test.createTestingModule({
      imports: [RealDbModule, RetrievalModule],
      providers: [
        {
          provide: TOKEN_VERIFIER,
          useValue: {
            verify: (token: string) => {
              const [role, alias = 'acme'] = token.split('@');
              return Promise.resolve({
                sub: USER,
                organization: [alias],
                realm_access: { roles: [role] },
              });
            },
          },
        },
        {
          provide: TENANT_DIRECTORY,
          useValue: { idForAlias: (a: string) => Promise.resolve(a === 'globex' ? GLOBEX : ACME) },
        },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    })
      .overrideProvider(QUERY_EMBEDDER)
      .useValue(embedder)
      .compile();
    app = mod.createNestApplication<NestExpressApplication>();
    applyJsonBodyLimit(app);
    await app.init();
    tenantDb = mod.get(TenantDbService);
    retrieval = mod.get(RetrievalService);
  });

  beforeEach(() => {
    embedder.fail = false;
    embedder.model = WORD_HASH_MODEL;
    embedder.vectorFor = undefined;
  });

  afterEach(cleanup);

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), pool.end()]);
  });

  describe('what retrieval may return', () => {
    it("never returns another tenant's chunks, even when they match better", async () => {
      const mine = await addDoc({ chunks: [{ content: 'Cà phê rang xay SAMPLE alpha' }] });
      const theirs = await addDoc({
        tenant: GLOBEX,
        chunks: [{ content: 'Cà phê rang xay SAMPLE alpha beta gamma' }],
      });
      const result = await retrieval.retrieve(ACME, 'cà phê rang xay alpha beta gamma');
      expect(docsOf(result.chunks)).toEqual([mine.documentId]);
      const asGlobex = await retrieval.retrieve(GLOBEX, 'cà phê rang xay alpha');
      expect(docsOf(asGlobex.chunks)).toEqual([theirs.documentId]);
    });

    it('the explicit tenant filter holds on its own: without RLS (owner) it still keeps other tenants out', async () => {
      await addDoc({ chunks: [{ content: 'Thép cuộn SAMPLE delta' }] });
      const theirs = await addDoc({
        tenant: GLOBEX,
        chunks: [{ content: 'Thép cuộn SAMPLE delta' }],
      });
      // The owner is not subject to RLS here, so only the WHERE clause separates the tenants.
      const ownerDb = drizzle(owner, { schema });
      const query = { model: WORD_HASH_MODEL, vector: wordHashVector('thép cuộn delta') };
      const [fts, vec] = await ownerDb.transaction(async (tx) => [
        await fullTextCandidates(tx, GLOBEX, 'thép cuộn delta', 20),
        await vectorCandidates(tx, GLOBEX, query, 20),
      ]);
      expect(fts.map((r) => r.document_id)).toEqual([theirs.documentId]);
      expect(vec.map((r) => r.document_id)).toEqual([theirs.documentId]);
    });

    it('RLS holds on its own: a filter naming another tenant than app.tenant_id finds nothing', async () => {
      await addDoc({ tenant: GLOBEX, chunks: [{ content: 'Xi măng SAMPLE epsilon' }] });
      const query = { model: WORD_HASH_MODEL, vector: wordHashVector('xi măng epsilon') };
      // app.tenant_id = ACME, WHERE asks for GLOBEX: RLS hides GLOBEX's rows.
      const [fts, vec] = await tenantDb.run(ACME, async (tx) => [
        await fullTextCandidates(tx, GLOBEX, 'xi măng epsilon', 20),
        await vectorCandidates(tx, GLOBEX, query, 20),
      ]);
      expect(fts).toEqual([]);
      expect(vec).toEqual([]);
    });

    it('only the current version of an approved document: reopened, unapproved and stale chunks stay out', async () => {
      const text = 'Giấy in khổ A4 SAMPLE zeta';
      // Approved at v2, with v1 chunks left behind (as if the delete at reopen had failed).
      const current = await addDoc({
        version: 2,
        chunks: [
          { content: text, version: 1 },
          { content: `${text} v2`, version: 2, ordinal: 0 },
        ],
      });
      // Reopened (needs_review at v2) and its v1 chunks never removed.
      const reopened = await addDoc({
        status: 'needs_review',
        version: 2,
        chunks: [{ content: text, version: 1 }],
      });
      // Never approved, but chunks exist (a job gone wrong).
      const unapproved = await addDoc({ status: 'needs_review', chunks: [{ content: text }] });

      const result = await retrieval.retrieve(ACME, 'giấy in khổ A4 zeta', { topK: 20 });
      expect(result.chunks.map((c) => c.chunkId)).toEqual([current.chunkIds[1]]);
      expect(result.chunks[0]).toMatchObject({ documentVersion: 2 });
      const ids = result.chunks.map((c) => c.documentId);
      expect(ids).not.toContain(reopened.documentId);
      expect(ids).not.toContain(unapproved.documentId);
    });

    it('vectors of another model are never compared; full-text still finds the chunk', async () => {
      const other = await addDoc({
        chunks: [{ content: 'Nước uống đóng chai SAMPLE eta', model: 'another-model' }],
      });
      const result = await retrieval.retrieve(ACME, 'nước uống đóng chai eta');
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]).toMatchObject({
        documentId: other.documentId,
        vectorRank: null,
        vectorDistance: null,
        ftsRank: 1,
      });
    });
  });

  describe('fusion and the debug fields', () => {
    it('a chunk both lists rank high beats one that only one list ranks first', async () => {
      // "vectorOnly" is the nearest vector but shares no word with the question; "both" is second
      // in both lists; "ftsOnly" has every word but a vector of another model (not in that list).
      const q = wordHashVector('bàn làm việc gỗ theta');
      const vectorOnly = await addDoc({ chunks: [{ content: 'SAMPLE iota', vector: q }] });
      const both = await addDoc({ chunks: [{ content: 'Bàn làm việc gỗ SAMPLE' }] });
      const ftsOnly = await addDoc({
        chunks: [{ content: 'Bàn làm việc gỗ theta SAMPLE', model: 'another-model' }],
      });
      embedder.vectorFor = () => q;
      const result = await retrieval.retrieve(ACME, 'bàn làm việc gỗ theta', { topK: 3 });
      const byDoc = new Map(result.chunks.map((c) => [c.documentId, c]));
      expect(byDoc.get(vectorOnly.documentId)).toMatchObject({ vectorRank: 1, ftsRank: null });
      expect(byDoc.get(ftsOnly.documentId)).toMatchObject({ vectorRank: null, ftsRank: 1 });
      expect(byDoc.get(both.documentId)).toMatchObject({ vectorRank: 2, ftsRank: 2 });
      expect(result.chunks[0]!.documentId).toBe(both.documentId);
      // RRF of ranks (2, 2) with k = 60.
      expect(result.chunks[0]!.score).toBeCloseTo(2 / 62, 12);
      expect(result).toMatchObject({ model: WORD_HASH_MODEL, topK: 3, candidates: 20 });
    });

    it('a question with no word at all finds nothing by full-text and does not fail', async () => {
      await addDoc({ chunks: [{ content: 'SAMPLE mu' }] });
      const result = await retrieval.retrieve(ACME, '?!? …', { topK: 5 });
      expect(result.chunks.every((c) => c.ftsRank === null)).toBe(true);
    });
    it('a long question with hyphens and quotes still finds the chunk by its rare word', async () => {
      const mine = await addDoc({ chunks: [{ content: "Dây cáp mạng SAMPLE xi9 O'Brien" }] });
      await addDoc({ chunks: [{ content: 'SAMPLE other' }] });
      // 40 distinct filler words first: the 32-word cap must not break the query.
      const filler = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
      const result = await retrieval.retrieve(ACME, `${filler} network-cable O'Brien xi9 & | ! (`);
      expect(result.chunks[0]).toMatchObject({ documentId: mine.documentId });
    });

    it('bounds top-k itself (Q&A calls the service directly, without the route validation)', async () => {
      await addDoc({ chunks: [{ content: 'SAMPLE xi10' }] });
      expect((await retrieval.retrieve(ACME, 'xi10', { topK: 100 })).topK).toBe(20);
      expect((await retrieval.retrieve(ACME, 'xi10', { topK: 0 })).topK).toBe(1);
      expect((await retrieval.retrieve(ACME, 'x'.repeat(5_000))).chunks).toBeDefined();
    });
  });

  describe('HNSW under RLS and the tenant filter', () => {
    const BIG = 2_000;

    /** A unit vector pointing mostly at dimension `d`, with a little noise so that ties are rare. */
    const near = (d: number, seed: number): number[] => {
      const v = Array.from({ length: schema.EMBEDDING_DIMENSIONS }, (_, i) =>
        i === d ? 1 : (((seed * 9301 + i * 49297) % 233280) / 233280) * 0.02,
      );
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return v.map((x) => x / n);
    };

    /** BIG approved chunks for `tenant`, all close to dimension 0, then fresh statistics. */
    async function seedBig(tenant: string): Promise<void> {
      const { documentId } = await addDoc({ tenant, chunks: [{ content: 'SAMPLE big' }] });
      const { rows } = await owner.query<{ id: string }>(
        `SELECT id FROM invoices WHERE document_id = $1`,
        [documentId],
      );
      await owner.query(
        `INSERT INTO chunks (tenant_id, document_id, document_version, invoice_id, kind, ordinal, content,
                             embedding, embedding_model, refs)
         SELECT $1, $2, 1, $3, 'lines', g, 'SAMPLE big ' || g,
                (SELECT array_agg(CASE WHEN i = 1 THEN 1 ELSE random() * 0.05 END)::real[]
                   FROM generate_series(1, 768) i WHERE g > 0)::vector,
                $4, '[]'::jsonb
           FROM generate_series(1, $5::int) g`,
        [tenant, documentId, rows[0]!.id, WORD_HASH_MODEL, BIG],
      );
      await owner.query('ANALYZE chunks');
      await owner.query('ANALYZE documents');
    }

    const explain = (tenant: string, query: { model: string; vector: number[] }, extra = sql``) =>
      tenantDb.run(tenant, async (tx) => {
        await tx.execute(hnswSettings(20));
        await tx.execute(extra);
        const { rows } = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN ${vectorSql(tenant, query, 20)}`,
        );
        return rows.map((l) => l['QUERY PLAN']).join('\n');
      });

    it('a tenant with 2,000 chunks: the planner still walks the HNSW index with the join and filters', async () => {
      await seedBig(ACME);
      const plan = await explain(ACME, { model: WORD_HASH_MODEL, vector: near(0, 1) });
      expect(plan).toContain('Index Scan using chunks_embedding_hnsw on chunks c');
      const rows = await tenantDb.run(ACME, (tx) =>
        vectorCandidates(tx, ACME, { model: WORD_HASH_MODEL, vector: near(0, 1) }, 20),
      );
      expect(rows).toHaveLength(20);
    }, 60_000);

    it('a small tenant inside a large table gets all its chunks; on the HNSW path the iterative scan is what finds them', async () => {
      await seedBig(GLOBEX);
      // Acme's 3 chunks point elsewhere: Globex's 2,000 are all nearer to the question.
      const mine = await addDoc({
        chunks: [5, 6, 7].map((d, i) => ({ content: `SAMPLE small ${d}`, vector: near(d, i) })),
      });
      const query = { model: WORD_HASH_MODEL, vector: near(0, 99) };

      // As used: the planner sees Acme is small and reads it by tenant (exact), so all 3 come back.
      const rows = await tenantDb.run(ACME, (tx) => vectorCandidates(tx, ACME, query, 20));
      expect(rows.map((r) => r.document_id)).toEqual(Array(3).fill(mine.documentId));

      // A tenant the planner thinks is large would walk HNSW instead. Forbidding the sort forces
      // that path here, to show what the iterative scan does on it.
      const forceHnsw = sql`SELECT set_config('enable_sort', 'off', true)`;
      expect(await explain(ACME, query, forceHnsw)).toContain('chunks_embedding_hnsw');
      /** Rows found on the forced HNSW path: with hnswSettings as used, or with the scan turned off. */
      const viaHnsw = (iterative: 'as configured' | 'off') =>
        tenantDb.run(ACME, async (tx) => {
          await tx.execute(hnswSettings(20));
          await tx.execute(forceHnsw);
          if (iterative === 'off') {
            await tx.execute(sql`SELECT set_config('hnsw.iterative_scan', 'off', true)`);
          }
          const { rows: found } = await tx.execute<{ id: string }>(vectorSql(ACME, query, 20));
          return found.length;
        });
      expect(await viaHnsw('as configured')).toBe(3);
      // Without it HNSW stops after ef_search candidates, all Globex's, and RLS drops them all.
      expect(await viaHnsw('off')).toBeLessThan(3);
    }, 60_000);
  });

  describe('POST /search/debug', () => {
    const debug = (body: unknown, token = 'viewer') =>
      request(app.getHttpServer())
        .post('/search/debug')
        .set('Authorization', `Bearer ${token}`)
        .send(body as object);

    it('answers the fused chunks with ranks and scores, for the caller tenant only', async () => {
      const mine = await addDoc({ chunks: [{ content: 'Mực in laser đen SAMPLE nu' }] });
      await addDoc({ tenant: GLOBEX, chunks: [{ content: 'Mực in laser đen SAMPLE nu' }] });
      const res = await debug({ question: 'mực in laser nu', topK: 3 }).expect(200);
      expect(res.body).toMatchObject({ model: WORD_HASH_MODEL, topK: 3, candidates: 20 });
      expect(res.body.chunks).toHaveLength(1);
      expect(res.body.chunks[0]).toMatchObject({
        documentId: mine.documentId,
        vectorRank: 1,
        ftsRank: 1,
        content: 'Mực in laser đen SAMPLE nu',
      });
      expect(typeof res.body.chunks[0].score).toBe('number');
      expect(typeof res.body.chunks[0].vectorDistance).toBe('number');
      expect(typeof res.body.chunks[0].ftsScore).toBe('number');
    });

    it('needs qa:ask', async () => {
      const res = await debug({ question: 'mực in' }, 'nobody').expect(403);
      expect(res.body.code).toBe('FORBIDDEN_PERMISSION');
    });

    it.each([
      ['no question', {}],
      ['an empty question', { question: '   ' }],
      ['a question over 1,000 characters', { question: 'x'.repeat(1001) }],
      ['a top-k over 20', { question: 'mực in', topK: 21 }],
      ['an unknown field', { question: 'mực in', sql: 'select 1' }],
    ])('400 BODY_INVALID for %s, without echoing it', async (_name, body) => {
      const res = await debug(body).expect(400);
      expect(res.body.code).toBe('BODY_INVALID');
      expect(JSON.stringify(res.body)).not.toContain('select 1');
    });

    it('503 AI_SERVICE_UNAVAILABLE when the question cannot be embedded', async () => {
      embedder.fail = true;
      const res = await debug({ question: 'mực in SAMPLE' }).expect(503);
      expect(res.body.code).toBe('AI_SERVICE_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toContain('SAMPLE');
    });
  });

  describe('Xong khi: golden set, hit@5', () => {
    type Corpus = {
      invoices: {
        datasetId: string;
        chunks: { kind: 'header' | 'lines'; ordinal: number; content: string }[];
      }[];
    };
    type Golden = { questions: { id: string; kind: string; question: string; expected: string }[] };
    type Vectors = {
      model: string;
      chunks: Record<string, number[]>;
      questions: Record<string, number[]>;
    };
    const fixture = <T>(name: string): T =>
      JSON.parse(readFileSync(path.join(__dirname, 'fixtures/retrieval', name), 'utf8')) as T;

    // Questions whose expected invoice also exists in another tenant, as a trap.
    const NOISE = ['invoice-0017', 'invoice-0058', 'invoice-0071'];
    const K = 5;

    it('hit@5 over the golden set, never with another tenant', async () => {
      const corpus = fixture<Corpus>('corpus.json');
      const golden = fixture<Golden>('golden.json');
      const vectorsFile = process.env.RETRIEVAL_GOLDEN_VECTORS;
      const real =
        vectorsFile !== undefined && vectorsFile !== ''
          ? (JSON.parse(readFileSync(vectorsFile, 'utf8')) as Vectors)
          : undefined;
      const model = real?.model ?? WORD_HASH_MODEL;
      // Many chunks tie on score (same words, same seller), and ties go by id: fixed ids make the
      // number reproducible, RETRIEVAL_GOLDEN_SEED shows how much it moves with another tie order.
      const seed = process.env.RETRIEVAL_GOLDEN_SEED ?? 't5.3';

      const docOf = new Map<string, string>(); // document id -> dataset id
      const datasetOf = (documentId: string) => docOf.get(documentId) ?? `other:${documentId}`;
      for (const inv of corpus.invoices) {
        const tenants = NOISE.includes(inv.datasetId) ? [ACME, GLOBEX] : [ACME];
        for (const tenant of tenants) {
          const { documentId } = await addDoc({
            idsFrom: `${seed}/${tenant}/${inv.datasetId}`,
            tenant,
            chunks: inv.chunks.map((c) => ({
              ...c,
              model,
              vector: real ? real.chunks[`${inv.datasetId}#${c.ordinal}`] : undefined,
            })),
          });
          docOf.set(documentId, tenant === ACME ? inv.datasetId : `globex:${inv.datasetId}`);
        }
      }
      embedder.model = model;
      if (real) {
        const byText = new Map(golden.questions.map((q) => [q.question, real.questions[q.id]]));
        embedder.vectorFor = (question) => byText.get(question);
      }

      const rows: {
        id: string;
        kind: string;
        vector: boolean;
        fts: boolean;
        hybrid: boolean;
        top: string;
      }[] = [];
      for (const q of golden.questions) {
        const hybrid = await retrieval.retrieve(ACME, q.question, { topK: K });
        const query = await embedder.embed(q.question);
        const [fts, vec] = await tenantDb.run(ACME, async (tx) => [
          await fullTextCandidates(tx, ACME, q.question, K),
          await vectorCandidates(tx, ACME, query, K),
        ]);
        const hits = (ids: string[]) => ids.map(datasetOf).includes(q.expected);
        const fused = hybrid.chunks.map((c) => c.documentId);
        expect(fused.map(datasetOf).some((d) => d.startsWith('globex:'))).toBe(false);
        rows.push({
          id: q.id,
          kind: q.kind,
          vector: hits(vec.map((r) => r.document_id)),
          fts: hits(fts.map((r) => r.document_id)),
          hybrid: hits(fused),
          top: datasetOf(fused[0] ?? ''),
        });
      }

      const count = (key: 'vector' | 'fts' | 'hybrid') => rows.filter((r) => r[key]).length;
      const mark = (b: boolean) => (b ? 'hit' : '-');
      // Printed on purpose: the numbers go to docs/learning-log.md (spec "Xong khi").
      process.stdout.write(
        [
          `\nGolden hit@${K} (model ${model}, seed ${seed}, ${corpus.invoices.length} invoices + ${NOISE.length} copies in another tenant)`,
          '| id | kind | vector | full-text | hybrid | top-1 |',
          '|---|---|---|---|---|---|',
          ...rows.map(
            (r) =>
              `| ${r.id} | ${r.kind} | ${mark(r.vector)} | ${mark(r.fts)} | ${mark(r.hybrid)} | ${r.top} |`,
          ),
          `| total | | ${count('vector')}/10 | ${count('fts')}/10 | ${count('hybrid')}/10 | |`,
          '',
        ].join('\n'),
      );
      // With real vectors: the 7/10 chosen before the first measurement (plan T5.3). With the
      // word-hashing embedder the vector list is noise and hybrid moved 6–8 over five tie orders
      // (code review), so CI holds full-text to 7 and hybrid to 6 instead of sitting on the edge.
      if (real) {
        expect(count('hybrid')).toBeGreaterThanOrEqual(7);
      } else {
        expect(count('fts')).toBeGreaterThanOrEqual(7);
        expect(count('hybrid')).toBeGreaterThanOrEqual(6);
      }
    }, 120_000);
  });
});
