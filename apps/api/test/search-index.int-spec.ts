/**
 * T5.2 end to end on a real Postgres (Testcontainers), as the app role: approve over HTTP -> the job
 * that approval enqueued -> IndexProcessor -> chunks; reopen over HTTP -> chunks gone in the same
 * transaction. The AI service is replaced by an in-process indexer (no Python, no network); the
 * queue by an in-memory one. Both "Xong khi" checks of the spec are here.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { InvoiceSchema, type Invoice } from 'contracts';
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
import { ReviewModule } from '../src/modules/review/review.module';
import type {
  AiIndexer,
  CurrentInvoiceRow,
} from '../src/modules/search/application/ai-indexer.port';
import { INDEX_QUEUE_PORT } from '../src/modules/search/application/index-queue.port';
import { IndexProcessor } from '../src/modules/search/application/index.processor';
import type { AiIndexResponse } from '../src/modules/search/domain/ai-index-response';
import {
  INDEX_FAILED,
  INDEX_JOB_INVALID,
  INDEX_RESPONSE_MISMATCH,
  INDEX_RETRY,
  PermanentIndexError,
  type IndexJobData,
} from '../src/modules/search/domain/index-job';
import { FakeIndexQueue } from '../src/modules/search/testing/fake-index-queue';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const USER = '00000000-0000-4000-8000-00000000f052';
const ATTEMPT = { attempt: 1, maxAttempts: 5 };

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

const invoice = (): Invoice =>
  InvoiceSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(__dirname, '../../../packages/contracts/fixtures/invoice.valid.json'),
        'utf8',
      ),
    ),
  );

/** A unit vector that depends only on `text`: same text, same vector. */
function vectorOf(text: string): number[] {
  const v = Array.from({ length: schema.EMBEDDING_DIMENSIONS }, () => 0);
  const digest = createHash('sha256').update(text).digest();
  for (let i = 0; i < 8; i++) v[digest[i]! % v.length]! += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** Stands in for POST /index: a header chunk and one line chunk built from the row it is sent. */
class StubIndexer implements AiIndexer {
  readonly rows: CurrentInvoiceRow[] = [];
  /** Runs while "the AI service" is working, i.e. between the two transactions of the processor. */
  during?: () => Promise<void>;
  /** Rewrites the answer, to send something that does not belong to the job. */
  tamper?: (r: AiIndexResponse) => AiIndexResponse;
  /** Thrown instead of answering, as the HTTP client would. */
  fail?: Error;

  async index(row: CurrentInvoiceRow): Promise<AiIndexResponse> {
    this.rows.push(row);
    await this.during?.();
    if (this.fail) throw this.fail;
    const data = row.data as Invoice;
    const chunk = (ordinal: number, content: string) => ({
      chunk: {
        tenant_id: row.tenant_id,
        document_id: row.document_id,
        document_version: row.document_version,
        invoice_id: row.id,
        kind: ordinal === 0 ? ('header' as const) : ('lines' as const),
        ordinal,
        content,
        refs: [{ document_id: row.document_id, field_path: 'invoiceNo', page: null }],
      },
      embedding: vectorOf(content),
    });
    const result = {
      model: 'stub-embedding',
      chunks: [
        chunk(0, `Hoá đơn ${data.invoiceNo} · ${data.seller.name} · v${row.document_version}`),
        chunk(1, `Dòng 1: ${data.lines[0]?.description ?? ''}`),
      ],
    };
    return this.tamper ? this.tamper(result) : result;
  }
}

describe('RAG index (T5.2): approve -> chunks, reopen -> gone', () => {
  let owner: Pool;
  let pool: Pool;
  let app: NestExpressApplication;
  let queue: FakeIndexQueue;
  let indexer: StubIndexer;
  let processor: IndexProcessor;

  async function seed(tenant = ACME): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO documents (id, tenant_id, status, source_type, storage_key, content_hash, version, uploaded_by)
       VALUES ($1, $2, 'needs_review', 'pdf', $3, $4, 1, $5)`,
      [id, tenant, `tenant/${tenant}/${id}`, randomBytes(32).toString('hex'), USER],
    );
    await owner.query(
      `INSERT INTO extractions (tenant_id, document_id, document_version, source, data, latency_ms)
       VALUES ($1, $2, 1, 'pdf', $3, 10)`,
      [tenant, id, JSON.stringify(invoice())],
    );
    return id;
  }

  const as = (tenant: string) => (tenant === GLOBEX ? 'accountant@globex' : 'accountant');
  const approve = (id: string, version: number, body: Invoice = invoice(), tenant = ACME) =>
    request(app.getHttpServer())
      .post(`/documents/${id}/approve`)
      .set('Authorization', `Bearer ${as(tenant)}`)
      .set('If-Match', `"${version}"`)
      .send(body);
  const reopen = (id: string, version: number) =>
    request(app.getHttpServer())
      .post(`/documents/${id}/reopen`)
      .set('Authorization', 'Bearer accountant')
      .set('If-Match', `"${version}"`);

  /** The job this approval enqueued (the queue is keyed by invoice id). */
  const jobOf = (documentId: string, version: number): IndexJobData => {
    const job = [...queue.jobs.values()].find(
      (j) => j.documentId === documentId && j.documentVersion === version,
    );
    if (!job) throw new Error('no index job for this approval');
    return job;
  };

  /** What retrieval would see: chunks visible to the app role in `tenant`. */
  async function visibleChunks(
    tenant: string,
    documentId: string,
  ): Promise<{ document_version: number; ordinal: number }[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
      const { rows } = await client.query<{ document_version: number; ordinal: number }>(
        `SELECT document_version, ordinal FROM chunks WHERE document_id = $1 ORDER BY ordinal`,
        [documentId],
      );
      return rows;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 2 });
    pool = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 6 });

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

    queue = new FakeIndexQueue();
    const mod = await Test.createTestingModule({
      imports: [RealDbModule, ReviewModule],
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
        { provide: ConfigService, useValue: {} },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    })
      .overrideProvider(INDEX_QUEUE_PORT)
      .useValue(queue)
      .compile();
    app = mod.createNestApplication<NestExpressApplication>();
    applyJsonBodyLimit(app);
    await app.init();
    indexer = new StubIndexer();
    processor = new IndexProcessor(mod.get(TenantDbService), indexer);
  });

  beforeEach(() => {
    indexer.during = undefined;
    indexer.tamper = undefined;
    indexer.fail = undefined;
    queue.down = false;
  });

  afterAll(async () => {
    await app.close();
    const mine = `SELECT id FROM documents WHERE uploaded_by = $1`;
    await owner.query(`DELETE FROM chunks WHERE document_id IN (${mine})`, [USER]);
    await owner.query(
      `DELETE FROM field_corrections WHERE extraction_id IN
         (SELECT id FROM extractions WHERE document_id IN (${mine}))`,
      [USER],
    );
    await owner.query(
      `DELETE FROM invoice_lines WHERE invoice_id IN
         (SELECT id FROM invoices WHERE document_id IN (${mine}))`,
      [USER],
    );
    await owner.query(`DELETE FROM invoices WHERE document_id IN (${mine})`, [USER]);
    await owner.query(`DELETE FROM extractions WHERE document_id IN (${mine})`, [USER]);
    await owner.query(`DELETE FROM audit_logs WHERE entity_id IN (${mine})`, [USER]);
    await owner.query(`DELETE FROM documents WHERE uploaded_by = $1`, [USER]);
    await Promise.all([owner.end(), pool.end()]);
  });

  describe('Xong khi 1: approve one invoice -> chunks appear; EXPLAIN uses HNSW', () => {
    it('approving enqueues one job for that version, and the job writes the chunks', async () => {
      const id = await seed();
      const res = await approve(id, 1);
      expect(res.status).toBe(200);

      const job = jobOf(id, 1);
      expect(job).toEqual({
        tenantId: ACME,
        documentId: id,
        documentVersion: 1,
        invoiceId: res.body.invoiceId,
      });
      expect(await processor.process(job, ATTEMPT)).toBe(true);
      expect(await visibleChunks(ACME, id)).toEqual([
        { document_version: 1, ordinal: 0 },
        { document_version: 1, ordinal: 1 },
      ]);
      // The row sent to the AI service has exactly the columns the chunker accepts (extra="forbid").
      expect(Object.keys(indexer.rows.at(-1)!).sort()).toEqual(
        ['data', 'document_id', 'document_version', 'id', 'tenant_id'].sort(),
      );
      const { rows } = await owner.query(
        `SELECT embedding_model, vector_dims(embedding) AS dims, content_tsv @@ plainto_tsquery('simple', $2) AS fts
           FROM chunks WHERE document_id = $1 AND ordinal = 0`,
        [id, invoice().invoiceNo],
      );
      expect(rows[0]).toEqual({ embedding_model: 'stub-embedding', dims: 768, fts: true });
    });

    /**
     * EXPLAIN of the nearest-neighbour query (ORDER BY <=> LIMIT) as the app role under RLS, after
     * `rows` chunks of one tenant were added and analysed. Everything happens in one owner session
     * that switches to the app role and is rolled back: statistics and rows of an uncommitted
     * transaction are visible to that session only.
     */
    async function planAt(rows: number): Promise<string> {
      const id = await seed();
      await approve(id, 1).expect(200);
      const { invoiceId } = jobOf(id, 1);
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO chunks (tenant_id, document_id, document_version, invoice_id, kind, ordinal,
                               content, embedding, embedding_model, refs)
           SELECT $1, $2, 1, $3, 'lines', g, 'SAMPLE ' || g,
                  (SELECT array_agg(random())::real[] FROM generate_series(1, 768) WHERE g > 0)::vector,
                  'stub-embedding', '[]'::jsonb
             FROM generate_series(1, $4::int) g`,
          [ACME, id, invoiceId, rows],
        );
        await client.query('ANALYZE chunks');
        await client.query('SET LOCAL ROLE invoice_app');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ACME]);
        const { rows: plan } = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT id FROM chunks ORDER BY embedding <=> $1::vector LIMIT 5`,
          [JSON.stringify(vectorOf('cà phê SAMPLE'))],
        );
        return plan.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }

    it('at 2,000 chunks the planner picks the HNSW index on its own, as the app role under RLS', async () => {
      const plan = await planAt(2_000);
      expect(plan).toContain('Index Scan using chunks_embedding_hnsw on chunks');
      // RLS still applies on top of the index scan.
      expect(plan).toContain("current_setting('app.tenant_id'");
    }, 60_000);

    it('with a handful of chunks it reads them by tenant and sorts instead (exact and cheaper)', async () => {
      const plan = await planAt(5);
      expect(plan).not.toContain('chunks_embedding_hnsw');
      expect(plan).toContain('Sort');
    });
  });

  describe('Xong khi 2: approve -> reopen -> gone; approve again -> only the new version', () => {
    it('reopening removes the chunks in its own transaction, re-approving indexes version 2 only', async () => {
      const id = await seed();
      await approve(id, 1).expect(200);
      await processor.process(jobOf(id, 1), ATTEMPT);
      expect(await visibleChunks(ACME, id)).toHaveLength(2);

      await reopen(id, 1).expect(200);
      // No job ran: the reopen request itself removed them.
      expect(await visibleChunks(ACME, id)).toEqual([]);
      const { rows: audit } = await owner.query(
        `SELECT meta FROM audit_logs WHERE entity_id = $1 AND action = 'document.reopened'`,
        [id],
      );
      expect(audit[0].meta).toMatchObject({ fromVersion: 1, version: 2, chunksRemoved: 2 });

      await approve(id, 2).expect(200);
      expect(await processor.process(jobOf(id, 2), ATTEMPT)).toBe(true);
      expect(await visibleChunks(ACME, id)).toEqual([
        { document_version: 2, ordinal: 0 },
        { document_version: 2, ordinal: 1 },
      ]);

      // The version-1 job delivered again (a late retry) must not bring version 1 back.
      expect(await processor.process(jobOf(id, 1), ATTEMPT)).toBe(false);
      expect((await visibleChunks(ACME, id)).map((c) => c.document_version)).toEqual([2, 2]);
    });

    it('a reopen while the AI service is working: the job writes nothing', async () => {
      const id = await seed();
      await approve(id, 1).expect(200);
      indexer.during = async () => {
        await reopen(id, 1).expect(200);
      };
      expect(await processor.process(jobOf(id, 1), ATTEMPT)).toBe(false);
      expect(await visibleChunks(ACME, id)).toEqual([]);
    });

    it('reopened AND approved again while the AI service works on version 1: version 1 is not written', async () => {
      const id = await seed();
      await approve(id, 1).expect(200);
      indexer.during = async () => {
        await reopen(id, 1).expect(200);
        await approve(id, 2).expect(200);
      };
      // The document is approved again, but at version 2: the version-1 answer must be dropped.
      expect(await processor.process(jobOf(id, 1), ATTEMPT)).toBe(false);
      expect(await visibleChunks(ACME, id)).toEqual([]);
      indexer.during = undefined;
      expect(await processor.process(jobOf(id, 2), ATTEMPT)).toBe(true);
      expect((await visibleChunks(ACME, id)).map((c) => c.document_version)).toEqual([2, 2]);
    });

    it('a job for a document that is reopened before it runs reads nothing and calls no AI', async () => {
      const id = await seed();
      await approve(id, 1).expect(200);
      await reopen(id, 1).expect(200);
      const calls = indexer.rows.length;
      expect(await processor.process(jobOf(id, 1), ATTEMPT)).toBe(false);
      expect(indexer.rows.length).toBe(calls);
    });
  });

  describe('idempotency and ordering', () => {
    it('the same job twice leaves one set of chunks', async () => {
      const id = await seed();
      await approve(id, 1).expect(200);
      await processor.process(jobOf(id, 1), ATTEMPT);
      await processor.process(jobOf(id, 1), ATTEMPT);
      expect(await visibleChunks(ACME, id)).toHaveLength(2);
    });

    it('a job that arrives before the approval commits waits for it, then indexes', async () => {
      const id = await seed();
      const invoiceId = randomUUID();
      const tx = await owner.connect();
      let done: Promise<boolean> | undefined;
      try {
        // Plays the approval: lock the row, approve, insert the invoice, and only then commit.
        await tx.query('BEGIN');
        await tx.query(`SELECT 1 FROM documents WHERE id = $1 FOR UPDATE`, [id]);
        done = processor.process(
          { tenantId: ACME, documentId: id, documentVersion: 1, invoiceId },
          ATTEMPT,
        );
        await waitForLockWaiter();
        await tx.query(`UPDATE documents SET status = 'approved' WHERE id = $1`, [id]);
        const inv = invoice();
        await tx.query(
          `INSERT INTO invoices (id, tenant_id, document_id, document_version, invoice_no, series,
             issue_date, seller_tax_code, seller_name, currency, subtotal, vat_amount, total, data, approved_by)
           VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13)`,
          [
            invoiceId,
            ACME,
            id,
            inv.invoiceNo,
            inv.series,
            inv.issueDate,
            inv.seller.taxCode,
            inv.seller.name,
            inv.currency,
            inv.subtotal,
            inv.total,
            JSON.stringify(inv),
            USER,
          ],
        );
        await tx.query('COMMIT');
      } finally {
        tx.release();
      }
      expect(await done).toBe(true);
      expect(await visibleChunks(ACME, id)).toHaveLength(2);
    });

    it('a job whose approval rolled back finds no invoice and does nothing', async () => {
      const id = await seed();
      await owner.query(`UPDATE documents SET status = 'approved' WHERE id = $1`, [id]);
      const ghost = { tenantId: ACME, documentId: id, documentVersion: 1, invoiceId: randomUUID() };
      const calls = indexer.rows.length;
      expect(await processor.process(ghost, ATTEMPT)).toBe(false);
      expect(indexer.rows.length).toBe(calls);
    });

    it('Redis down: the approval answers 503 and leaves no trace', async () => {
      const id = await seed();
      queue.down = true;
      const res = await approve(id, 1);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('QUEUE_UNAVAILABLE');
      const { rows } = await owner.query(
        `SELECT d.status, (SELECT count(*)::int FROM invoices WHERE document_id = d.id) AS invoices
           FROM documents d WHERE d.id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ status: 'needs_review', invoices: 0 });
    });
  });

  describe('isolation', () => {
    it('another tenant sees none of the chunks, and cannot write into this tenant', async () => {
      const id = await seed();
      await approve(id, 1).expect(200);
      await processor.process(jobOf(id, 1), ATTEMPT);
      expect(await visibleChunks(ACME, id)).toHaveLength(2);
      expect(await visibleChunks(GLOBEX, id)).toEqual([]);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [GLOBEX]);
        await expect(
          client.query(`DELETE FROM chunks WHERE document_id = $1`, [id]),
        ).resolves.toMatchObject({ rowCount: 0 });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await visibleChunks(ACME, id)).toHaveLength(2);
    });
  });

  describe('what a failed attempt becomes (retry or not)', () => {
    async function approved(): Promise<IndexJobData> {
      const id = await seed();
      await approve(id, 1).expect(200);
      return jobOf(id, 1);
    }

    it('a job payload that does not parse is not retried', async () => {
      await expect(
        processor.process({ documentId: 'not-a-uuid', tenantId: ACME }, ATTEMPT),
      ).rejects.toMatchObject({ code: INDEX_JOB_INVALID, retryable: false });
    });

    it('a transient AI failure before the last attempt is retried', async () => {
      const job = await approved();
      indexer.fail = new Error('AI service answered 503');
      await expect(processor.process(job, { attempt: 1, maxAttempts: 5 })).rejects.toMatchObject({
        code: INDEX_RETRY,
        retryable: true,
      });
      expect(await visibleChunks(ACME, job.documentId)).toEqual([]);
    });

    it('the same failure on the last attempt ends the job', async () => {
      const job = await approved();
      indexer.fail = new Error('AI service answered 503');
      await expect(processor.process(job, { attempt: 5, maxAttempts: 5 })).rejects.toMatchObject({
        code: INDEX_FAILED,
        retryable: false,
      });
    });

    it('a permanent AI failure keeps its own code and is not retried', async () => {
      const job = await approved();
      indexer.fail = new PermanentIndexError('INDEX_REQUEST_REJECTED');
      await expect(processor.process(job, ATTEMPT)).rejects.toMatchObject({
        code: 'INDEX_REQUEST_REJECTED',
        retryable: false,
      });
    });

    it.each([
      [
        'two chunks with the same ordinal',
        (r: AiIndexResponse) => ({
          ...r,
          chunks: r.chunks.map((c) => ({ ...c, chunk: { ...c.chunk, ordinal: 0 } })),
        }),
      ],
      ['no header first', (r: AiIndexResponse) => ({ ...r, chunks: r.chunks.slice(1) })],
    ])('%s: refused before the database, not retried', async (_name, tamper) => {
      const job = await approved();
      indexer.tamper = tamper;
      await expect(processor.process(job, ATTEMPT)).rejects.toMatchObject({
        code: INDEX_RESPONSE_MISMATCH,
        retryable: false,
      });
      expect(await visibleChunks(ACME, job.documentId)).toEqual([]);
    });
  });

  describe('isolation (answers)', () => {
    it('an AI answer for another tenant is refused and nothing is written', async () => {
      const id = await seed();
      await approve(id, 1).expect(200);
      indexer.tamper = (r) => ({
        ...r,
        chunks: r.chunks.map((c) => ({ ...c, chunk: { ...c.chunk, tenant_id: GLOBEX } })),
      });
      await expect(processor.process(jobOf(id, 1), ATTEMPT)).rejects.toMatchObject({
        code: INDEX_RESPONSE_MISMATCH,
        retryable: false,
      });
      expect(await visibleChunks(ACME, id)).toEqual([]);
    });
  });

  /** Waits until one session is blocked on a row lock of `documents`. */
  async function waitForLockWaiter(): Promise<void> {
    const client = await owner.connect();
    try {
      for (let i = 0; i < 200; i++) {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE '%documents%'`,
        );
        if (rows[0]!.n >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('The job never reached the row lock');
    } finally {
      client.release();
    }
  }
});
