/**
 * T5.4 on a real Postgres (Testcontainers) as the app role under RLS: Q&A with citations.
 * - The number tool: parameterized SQL over `current_invoices` / `current_invoice_lines` only (no
 *   double counting of versions, no reopened invoice, no other tenant), filters as parameters.
 * - Lookup answers: citations must be chunks retrieved for this question, or the answer is refused.
 * - `POST /qa/ask` as Server-Sent Events, its refusals and errors.
 * - "Xong khi": the 10 golden questions (fixtures/qa/golden.json).
 *
 * The AI service is replaced by a word-hashing embedder and a scripted model (no network). To run the
 * golden set against a real model, start the AI service (`pnpm dev:ai`, with a model key) and set
 * QA_GOLDEN_AI_URL (and QA_GOLDEN_AI_TOKEN when it is not the dev token). Only that test then calls
 * the AI service: one /classify per question and one /answer per lookup. Retrieval keeps the fake
 * embedder (measured with real vectors in T5.3).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  QA_STREAM_EVENTS,
  type QaAggregateFilter,
  type QaAggregateResult,
  type QaCitation,
  type QaRoute,
} from 'contracts';
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
import { runAggregate } from '../src/modules/qa/application/aggregate';
import { QA_MODEL, type QaModel } from '../src/modules/qa/application/qa-model.port';
import { QaService } from '../src/modules/qa/application/qa.service';
import { checkCitations } from '../src/modules/qa/domain/citations';
import { HttpQaModel } from '../src/modules/qa/infra/http-qa-model';
import { QaModule } from '../src/modules/qa/qa.module';
import { QUERY_EMBEDDER } from '../src/modules/search/application/query-embedder.port';
import {
  RetrievalService,
  type RetrievalResult,
} from '../src/modules/search/application/retrieval';
import { FakeQaModel } from '../src/modules/qa/testing/fake-qa-model';
import {
  FakeQueryEmbedder,
  WORD_HASH_MODEL,
  wordHashVector,
} from '../src/modules/search/testing/fake-query-embedder';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
/** Uploader of every row this file writes, so cleanup touches nothing else. */
const USER = '00000000-0000-4000-8000-00000000f054';
const ENV = { RAG_TOP_K: 5, RAG_CANDIDATES: 20, NODE_ENV: 'test' };
/** "Today" of every question here, so that "tháng 9" and the golden set mean fixed dates. */
const TODAY = new Date('2026-11-11T03:00:00Z');
const DATASET = path.join(__dirname, '../../../eval/datasets/v1/documents');

type Line = {
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  vatRate: number;
  amount: number;
};
/** The contract's Invoice (packages/contracts/src/invoice.ts), as stored in `invoices.data`. */
type InvoiceJson = {
  seller: { name: string; taxCode: string; address: string };
  buyer: { name: string; taxCode: string | null; address: string };
  invoiceNo: string;
  series: string;
  issueDate: string;
  currency: string;
  lines: Line[];
  subtotal: number;
  vatBreakdown: { rate: number; base: number; amount: number }[];
  total: number;
  fieldMeta: Record<
    string,
    { confidence: number; evidence: { page: number; text: string } | null }
  >;
};

/** Invoice numbers of `invoice()`: distinct and reproducible, no random source needed. */
let invoiceSeq = 0;

/** A small consistent invoice: lines at 10% VAT. */
function invoice(over: {
  seller?: string;
  taxCode?: string;
  date?: string;
  currency?: string;
  lines?: [string, number][];
  invoiceNo?: string;
}): InvoiceJson {
  const lines = (over.lines ?? [['Dịch vụ SAMPLE', 1_000_000]]).map(
    ([description, amount]): Line => ({
      description,
      quantity: 1,
      unit: 'gói',
      unitPrice: amount,
      vatRate: 10,
      amount,
    }),
  );
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const vat = Math.round(subtotal / 10);
  return {
    seller: {
      name: over.seller ?? 'Công ty SAMPLE Bán',
      taxCode: over.taxCode ?? '0100000001',
      address: 'SAMPLE',
    },
    buyer: { name: 'Công ty SAMPLE Mua', taxCode: null, address: 'SAMPLE' },
    invoiceNo: over.invoiceNo ?? String((invoiceSeq += 1)).padStart(7, '0'),
    series: 'C26TSM',
    issueDate: over.date ?? '2026-09-10',
    currency: over.currency ?? 'VND',
    lines,
    subtotal,
    vatBreakdown: [{ rate: 10, base: subtotal, amount: vat }],
    total: subtotal + vat,
    fieldMeta: { total: { confidence: 0.9, evidence: { page: 2, text: 'SAMPLE' } } },
  };
}

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

type SseEvent = { event: string; data: unknown };

/** Parses `text/event-stream` like an EventSource, and checks each event against the contract. */
function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))!.slice('event: '.length);
      const data = JSON.parse(
        lines.find((l) => l.startsWith('data: '))!.slice('data: '.length),
      ) as unknown;
      const parsed = QA_STREAM_EVENTS[event as keyof typeof QA_STREAM_EVENTS].safeParse(data);
      if (!parsed.success) throw new Error(`event ${event} does not match the contract`);
      return { event, data };
    });
}

const filter = (over: Partial<QaAggregateFilter>): QaAggregateFilter => ({
  metric: 'total',
  sellerName: null,
  sellerTaxCode: null,
  issueDateFrom: null,
  issueDateTo: null,
  currency: null,
  itemDescription: null,
  ...over,
});

describe('Q&A with citations (T5.4)', () => {
  let owner: Pool;
  let pool: Pool;
  let app: NestExpressApplication;
  let tenantDb: TenantDbService;
  let retrieval: RetrievalService;
  let embedder: FakeQueryEmbedder;
  let fake: FakeQaModel;
  /** The model the app uses; tests swap it (the fake, or the real AI service for the golden run). */
  let model: QaModel;

  /**
   * One document approved at each of `versions` (an invoice row and its lines per version), at
   * document version `version`, with chunks of the current version. Written as the owner (the
   * container's superuser, not subject to RLS).
   */
  async function addDoc(spec: {
    tenant?: string;
    status?: string;
    version?: number;
    versions?: { version: number; invoice: InvoiceJson }[];
    invoice?: InvoiceJson;
    chunks?: { content: string; kind?: 'header' | 'lines'; ordinal?: number }[];
    idsFrom?: string;
  }) {
    const tenant = spec.tenant ?? ACME;
    const version = spec.version ?? 1;
    const versions = spec.versions ?? [{ version, invoice: spec.invoice ?? invoice({}) }];
    const documentId = spec.idsFrom ? uuidFrom(`${spec.idsFrom}/document`) : randomUUID();
    await owner.query(
      `INSERT INTO documents (id, tenant_id, status, source_type, storage_key, content_hash, version, uploaded_by)
       VALUES ($1, $2, $3, 'pdf', $4, $5, $6, $7)`,
      [
        documentId,
        tenant,
        spec.status ?? 'approved',
        `tenant/${tenant}/${documentId}`,
        randomBytes(32).toString('hex'),
        version,
        USER,
      ],
    );
    const invoiceIds = new Map<number, string>();
    for (const v of versions) {
      const inv = v.invoice;
      const id = spec.idsFrom ? uuidFrom(`${spec.idsFrom}/invoice/${v.version}`) : randomUUID();
      await owner.query(
        `INSERT INTO invoices (id, tenant_id, document_id, document_version, invoice_no, series, issue_date,
                               seller_tax_code, seller_name, buyer_tax_code, currency, subtotal, vat_amount,
                               total, data, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          id,
          tenant,
          documentId,
          v.version,
          inv.invoiceNo,
          inv.series,
          inv.issueDate,
          inv.seller.taxCode,
          inv.seller.name,
          inv.buyer.taxCode,
          inv.currency,
          inv.subtotal,
          inv.vatBreakdown.reduce((s, b) => s + b.amount, 0),
          inv.total,
          JSON.stringify(inv),
          USER,
        ],
      );
      for (const [i, l] of inv.lines.entries()) {
        await owner.query(
          `INSERT INTO invoice_lines (tenant_id, invoice_id, line_no, description, quantity, unit, unit_price, vat_rate, amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [tenant, id, i + 1, l.description, l.quantity, l.unit, l.unitPrice, l.vatRate, l.amount],
        );
      }
      invoiceIds.set(v.version, id);
    }
    const chunkIds: string[] = [];
    for (const [i, c] of (spec.chunks ?? []).entries()) {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO chunks (id, tenant_id, document_id, document_version, invoice_id, kind, ordinal,
                             content, embedding, embedding_model, refs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11) RETURNING id`,
        [
          spec.idsFrom ? uuidFrom(`${spec.idsFrom}/chunk/${i}`) : randomUUID(),
          tenant,
          documentId,
          version,
          invoiceIds.get(version),
          c.kind ?? (i === 0 ? 'header' : 'lines'),
          c.ordinal ?? i,
          c.content,
          JSON.stringify(wordHashVector(c.content)),
          WORD_HASH_MODEL,
          JSON.stringify([{ document_id: documentId, field_path: 'invoiceNo', page: null }]),
        ],
      );
      chunkIds.push(rows[0]!.id);
    }
    return { documentId, invoiceIds, chunkIds };
  }

  async function cleanup(): Promise<void> {
    const mine = `SELECT id FROM documents WHERE uploaded_by = $1`;
    await owner.query(`DELETE FROM chunks WHERE document_id IN (${mine})`, [USER]);
    await owner.query(
      `DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE document_id IN (${mine}))`,
      [USER],
    );
    await owner.query(`DELETE FROM invoices WHERE document_id IN (${mine})`, [USER]);
    await owner.query(`DELETE FROM documents WHERE uploaded_by = $1`, [USER]);
  }

  const aggregate = (tenant: string, f: QaAggregateFilter) =>
    tenantDb.run(tenant, (tx) => runAggregate(tx, tenant, f));

  const ask = (question: unknown, role = 'accountant@acme') =>
    request(app.getHttpServer())
      .post('/qa/ask')
      .set('authorization', `Bearer ${role}`)
      .send({ question })
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => done(null, text));
      });
  const events = async (question: string, role?: string): Promise<SseEvent[]> => {
    const res = await ask(question, role).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    return parseSse(res.body as string);
  };
  const names = (es: SseEvent[]) => es.map((e) => e.event);
  const citationsOf = (es: SseEvent[]) =>
    (es.find((e) => e.event === 'citations')?.data as { citations: QaCitation[] } | undefined)
      ?.citations ?? [];

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
    fake = new FakeQaModel();
    model = fake;
    const delegate: QaModel = {
      classify: (q, today, signal) => model.classify(q, today, signal),
      answer: (q, sources, signal) => model.answer(q, sources, signal),
    };
    const mod = await Test.createTestingModule({
      imports: [RealDbModule, QaModule],
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
      .overrideProvider(QA_MODEL)
      .useValue(delegate)
      .compile();
    app = mod.createNestApplication<NestExpressApplication>();
    applyJsonBodyLimit(app);
    await app.init();
    tenantDb = mod.get(TenantDbService);
    retrieval = mod.get(RetrievalService);
    mod.get(QaService).now = () => TODAY;
  });

  beforeEach(() => {
    fake = new FakeQaModel();
    model = fake;
    embedder.fail = false;
    embedder.questions.length = 0;
  });

  afterEach(cleanup);

  afterAll(async () => {
    await app.close();
    await Promise.all([owner.end(), pool.end()]);
  });

  describe('the number tool reads what is approved now', () => {
    it('sums one supplier over a date range, per currency, counting only matching invoices', async () => {
      const a = await addDoc({ invoice: invoice({ seller: 'Garcia SAMPLE', date: '2026-09-02' }) });
      await addDoc({
        invoice: invoice({
          seller: 'Garcia SAMPLE',
          date: '2026-09-30',
          lines: [['x', 2_000_000]],
        }),
      });
      await addDoc({
        invoice: invoice({
          seller: 'Garcia SAMPLE',
          date: '2026-09-15',
          currency: 'USD',
          lines: [['x', 5000]],
        }),
      });
      await addDoc({ invoice: invoice({ seller: 'Garcia SAMPLE', date: '2026-10-01' }) }); // outside
      await addDoc({ invoice: invoice({ seller: 'Other SAMPLE', date: '2026-09-10' }) }); // other seller

      const result = await aggregate(
        ACME,
        filter({ sellerName: 'garcia', issueDateFrom: '2026-09-01', issueDateTo: '2026-09-30' }),
      );
      expect(result.results).toEqual([
        { currency: 'USD', amount: 5500 },
        { currency: 'VND', amount: 1_100_000 + 2_200_000 },
      ]);
      expect(result.invoiceCount).toBe(3);
      expect(result.sellers).toEqual([{ name: 'Garcia SAMPLE', taxCode: '0100000001' }]);
      expect(result.sellerCount).toBe(1);
      // Sources: oldest first, the summed field, its page from the approved fieldMeta.
      expect(result.citations[0]).toMatchObject({
        n: 1,
        documentId: a.documentId,
        documentVersion: 1,
        invoiceId: a.invoiceIds.get(1),
        chunkId: null,
        refs: [{ document_id: a.documentId, field_path: 'total', page: 2 }],
      });
    });

    it('lists every supplier a "contains" name matched, so a merged sum is visible', async () => {
      await addDoc({ invoice: invoice({ seller: 'Garcia-Riley SAMPLE', taxCode: '0100000003' }) });
      await addDoc({ invoice: invoice({ seller: 'Garcia Ltd SAMPLE', taxCode: '0100000004' }) });
      await addDoc({ invoice: invoice({ seller: 'Garcia Ltd SAMPLE', taxCode: '0100000004' }) });
      const result = await aggregate(ACME, filter({ sellerName: 'garcia' }));
      expect(result.invoiceCount).toBe(3);
      expect(result.sellers).toEqual([
        { name: 'Garcia Ltd SAMPLE', taxCode: '0100000004' },
        { name: 'Garcia-Riley SAMPLE', taxCode: '0100000003' },
      ]);
      expect(result.sellerCount).toBe(2);
    });

    it('counts a document approved twice once, with the values of its current version', async () => {
      await addDoc({
        version: 2,
        versions: [
          {
            version: 1,
            invoice: invoice({ seller: 'Versioned SAMPLE', lines: [['x', 1_000_000]] }),
          },
          {
            version: 2,
            invoice: invoice({ seller: 'Versioned SAMPLE', lines: [['x', 3_000_000]] }),
          },
        ],
      });
      const result = await aggregate(ACME, filter({ sellerName: 'Versioned' }));
      expect(result.results).toEqual([{ currency: 'VND', amount: 3_300_000 }]);
      expect(result.invoiceCount).toBe(1);
    });

    it('leaves out a reopened document, on invoices and on lines', async () => {
      // Approved at version 1, reopened (version 2, no invoice row at 2): no longer approved.
      await addDoc({
        status: 'needs_review',
        version: 2,
        versions: [
          { version: 1, invoice: invoice({ seller: 'Reopened SAMPLE', lines: [['Cà phê', 500]] }) },
        ],
      });
      expect((await aggregate(ACME, filter({ sellerName: 'Reopened' }))).invoiceCount).toBe(0);
      const lines = await aggregate(
        ACME,
        filter({ metric: 'lineAmount', sellerName: 'Reopened', itemDescription: 'cà phê' }),
      );
      expect(lines.invoiceCount).toBe(0);
    });

    it('sums the lines of an item from the current version only', async () => {
      const doc = await addDoc({
        version: 2,
        versions: [
          {
            version: 1,
            invoice: invoice({ seller: 'Coffee SAMPLE', lines: [['Cà phê rang', 900]] }),
          },
          {
            version: 2,
            invoice: invoice({
              seller: 'Coffee SAMPLE',
              lines: [
                ['Trà SAMPLE', 100],
                ['Cà phê rang xay', 1_000],
                ['CÀ PHÊ hạt', 2_000],
              ],
            }),
          },
        ],
      });
      const result = await aggregate(
        ACME,
        filter({ metric: 'lineAmount', itemDescription: 'cà phê' }),
      );
      expect(result.results).toEqual([{ currency: 'VND', amount: 3_000 }]);
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0]!.refs.map((r) => r.field_path)).toEqual([
        'lines.1.amount',
        'lines.2.amount',
      ]);
      expect(result.citations[0]!.documentId).toBe(doc.documentId);
      const count = await aggregate(
        ACME,
        filter({ metric: 'invoiceCount', itemDescription: 'cà phê' }),
      );
      expect(count).toMatchObject({ results: [], invoiceCount: 1 });
      expect(count.citations[0]!.refs.map((r) => r.field_path)).toEqual([
        'lines.1.description',
        'lines.2.description',
      ]);
    });

    it("never counts another tenant's invoices, by the explicit filter and by RLS", async () => {
      await addDoc({ invoice: invoice({ seller: 'Shared SAMPLE' }) });
      await addDoc({ tenant: GLOBEX, invoice: invoice({ seller: 'Shared SAMPLE' }) });
      await addDoc({ tenant: GLOBEX, invoice: invoice({ seller: 'Shared SAMPLE' }) });
      expect((await aggregate(ACME, filter({ sellerName: 'Shared' }))).invoiceCount).toBe(1);
      expect((await aggregate(GLOBEX, filter({ sellerName: 'Shared' }))).invoiceCount).toBe(2);
      // The explicit filter alone: RLS set to GLOBEX, query asking for ACME → nothing.
      const crossed = await tenantDb.run(GLOBEX, (tx) =>
        runAggregate(tx, ACME, filter({ sellerName: 'Shared' })),
      );
      expect(crossed.invoiceCount).toBe(0);
    });

    it('treats model text as values: wildcards, quotes and SQL match literally', async () => {
      await addDoc({ invoice: invoice({ seller: 'Plain SAMPLE' }) });
      await addDoc({ invoice: invoice({ seller: '100% SAMPLE' }) });
      for (const name of ['%', '_', "' OR 1=1 --", 'SAMPLE; DROP TABLE invoices']) {
        const r = await aggregate(ACME, filter({ sellerName: name }));
        expect([name, r.invoiceCount]).toEqual([name, name === '%' ? 1 : 0]);
      }
      expect((await aggregate(ACME, filter({ sellerTaxCode: '0100000001' }))).invoiceCount).toBe(2);
    });

    it('filters by tax code, currency and the other metrics', async () => {
      await addDoc({
        invoice: invoice({ seller: 'M SAMPLE', taxCode: '0100000002', lines: [['x', 1_000]] }),
      });
      await addDoc({
        invoice: invoice({
          seller: 'M SAMPLE',
          taxCode: '0100000002',
          currency: 'USD',
          lines: [['x', 30]],
        }),
      });
      const tax = '0100000002';
      expect(
        (await aggregate(ACME, filter({ metric: 'subtotal', sellerTaxCode: tax }))).results,
      ).toEqual([
        { currency: 'USD', amount: 30 },
        { currency: 'VND', amount: 1_000 },
      ]);
      const vat = await aggregate(
        ACME,
        filter({ metric: 'vatAmount', sellerTaxCode: tax, currency: 'VND' }),
      );
      expect(vat.results).toEqual([{ currency: 'VND', amount: 100 }]);
      expect(vat.citations[0]!.refs.map((r) => r.field_path)).toEqual(['vatBreakdown.0.amount']);
      const count = await aggregate(ACME, filter({ metric: 'invoiceCount', sellerTaxCode: tax }));
      expect(count).toMatchObject({ results: [], invoiceCount: 2 });
    });
  });

  describe('POST /qa/ask', () => {
    const CHUNK = 'Hoá đơn / Invoice: C26TSM-0000001 · Người bán / Seller: Alpha SAMPLE · mực in';

    it('answers a lookup with tokens, then citations of the retrieved chunks, then done', async () => {
      const doc = await addDoc({
        chunks: [{ content: CHUNK }, { content: 'Dòng hàng mực in SAMPLE' }],
      });
      fake.reply = (_q, sources) => ({
        insufficientEvidence: false,
        answer: `Người bán là Alpha SAMPLE [${sources.indexOf(CHUNK) + 1}].`,
      });
      const es = await events('Ai bán mực in SAMPLE?');
      expect(names(es).slice(-2)).toEqual(['citations', 'done']);
      expect(
        names(es)
          .slice(0, -2)
          .every((n) => n === 'token'),
      ).toBe(true);
      const text = es
        .flatMap((e) => (e.event === 'token' ? [(e.data as { text: string }).text] : []))
        .join('');
      expect(text).toMatch(/^Người bán là Alpha SAMPLE \[\d\]\.$/);
      const [cited] = citationsOf(es);
      expect(cited).toMatchObject({
        documentId: doc.documentId,
        documentVersion: 1,
        invoiceId: doc.invoiceIds.get(1),
      });
      expect(cited!.chunkId).toBe(doc.chunkIds[0]);
      expect(cited!.refs).toEqual([
        { document_id: doc.documentId, field_path: 'invoiceNo', page: null },
      ]);
      // The router saw the question only; the answer step saw exactly the retrieved chunks.
      expect(fake.classified).toEqual([{ question: 'Ai bán mực in SAMPLE?', today: '2026-11-11' }]);
      const retrieved = await retrieval.retrieve(ACME, 'Ai bán mực in SAMPLE?');
      expect(fake.answered[0]!.sources).toEqual(retrieved.chunks.map((c) => c.content));
    });

    it.each([
      ['a source that was not retrieved', 'Alpha SAMPLE [9].'],
      ['no citation at all', 'Alpha SAMPLE.'],
      ['a citation list it cannot check', 'Alpha SAMPLE [1-9].'],
      // A stored invoice telling the model to send the reader somewhere (security review).
      [
        'a link no cited source contains',
        'Alpha SAMPLE [1]. Thanh toán tại https://evil.example/pay.',
      ],
    ])('refuses an answer citing %s, and streams none of its text', async (_name, answer) => {
      await addDoc({ chunks: [{ content: CHUNK }] });
      fake.reply = { insufficientEvidence: false, answer };
      const es = await events('Ai bán mực in?');
      expect(es).toEqual([
        { event: 'refusal', data: { reason: 'ANSWER_REJECTED' } },
        { event: 'done', data: {} },
      ]);
    });

    it('keeps a link that is written in the cited source', async () => {
      await addDoc({ chunks: [{ content: `${CHUNK} · Website: https://alpha.example` }] });
      fake.reply = { insufficientEvidence: false, answer: 'Website: https://alpha.example [1].' };
      const es = await events('Website của Alpha SAMPLE?');
      expect(names(es)).toContain('citations');
    });

    it('says it does not know when the model finds no evidence, or answers off-schema', async () => {
      await addDoc({ chunks: [{ content: CHUNK }] });
      fake.reply = { insufficientEvidence: true, answer: '' };
      expect((await events('Ai bán mực in?'))[0]).toEqual({
        event: 'refusal',
        data: { reason: 'INSUFFICIENT_EVIDENCE' },
      });
      fake.reply = null;
      expect((await events('Ai bán mực in?'))[0]).toEqual({
        event: 'refusal',
        data: { reason: 'ANSWER_REJECTED' },
      });
    });

    it('does not call the answer step when nothing is indexed for the tenant', async () => {
      await addDoc({ tenant: GLOBEX, chunks: [{ content: CHUNK }] });
      const es = await events('Ai bán mực in?');
      expect(es[0]).toEqual({ event: 'refusal', data: { reason: 'INSUFFICIENT_EVIDENCE' } });
      expect(fake.answered).toEqual([]);
    });

    it('refuses an out-of-scope question without retrieving anything', async () => {
      fake.route = { intent: 'out_of_scope', filter: null };
      const es = await events('Thủ đô của Pháp là gì?');
      expect(es[0]).toEqual({ event: 'refusal', data: { reason: 'OUT_OF_SCOPE' } });
      expect(embedder.questions).toEqual([]);
      expect(fake.answered).toEqual([]);
    });

    it('streams an aggregate as data with its filter and sources', async () => {
      await addDoc({ invoice: invoice({ seller: 'Garcia SAMPLE', date: '2026-09-02' }) });
      fake.route = {
        intent: 'aggregate',
        filter: filter({
          sellerName: 'Garcia',
          issueDateFrom: '2026-09-01',
          issueDateTo: '2026-09-30',
        }),
      };
      const es = await events('Tháng 9 chi bao nhiêu cho Garcia?');
      expect(names(es)).toEqual(['aggregate', 'citations', 'done']);
      expect((es[0]!.data as QaAggregateResult).results).toEqual([
        { currency: 'VND', amount: 1_100_000 },
      ]);
      expect(citationsOf(es)).toHaveLength(1);
      expect(embedder.questions).toEqual([]); // no retrieval on the number path
    });

    it.each([
      ['no filter', { intent: 'aggregate', filter: null }, 'ANSWER_REJECTED'],
      [
        'dates the wrong way round',
        {
          intent: 'aggregate',
          filter: filter({ issueDateFrom: '2026-10-01', issueDateTo: '2026-09-01' }),
        },
        'ANSWER_REJECTED',
      ],
      [
        'no matching invoice',
        { intent: 'aggregate', filter: filter({ sellerName: 'Nobody' }) },
        'NO_MATCHING_INVOICES',
      ],
      // Postgres would fail on both (a 500): refused before any SQL (security review).
      [
        'a NUL in the supplier',
        { intent: 'aggregate', filter: filter({ sellerName: 'Garcia\u0000' }) },
        'ANSWER_REJECTED',
      ],
      [
        'year 0',
        { intent: 'aggregate', filter: filter({ issueDateFrom: '0000-01-01' }) },
        'ANSWER_REJECTED',
      ],
    ] as [string, QaRoute, string][])(
      'refuses an aggregate with %s',
      async (_name, route, reason) => {
        await addDoc({ invoice: invoice({ seller: 'Garcia SAMPLE' }) });
        fake.route = route;
        expect((await events('Tổng chi?'))[0]).toEqual({ event: 'refusal', data: { reason } });
      },
    );

    it('answers 503 AI_SERVICE_UNAVAILABLE, without the question, when the model is down', async () => {
      fake.fail = true;
      const res = await ask('Ai bán mực in SAMPLE?').expect(503);
      const body = JSON.parse(res.body as string) as { code: string };
      expect(body.code).toBe('AI_SERVICE_UNAVAILABLE');
      expect(res.body as string).not.toContain('SAMPLE');
    });

    it('refuses a missing, empty or too long question with 400 BODY_INVALID', async () => {
      for (const q of [undefined, '   ', 'x'.repeat(1001), 42, 'Ai bán\u0000SAMPLE?']) {
        const res = await ask(q).expect(400);
        expect((JSON.parse(res.body as string) as { code: string }).code).toBe('BODY_INVALID');
      }
      expect(fake.classified).toEqual([]);
    });

    it('is open to a viewer (qa:ask) and answers from their own tenant only', async () => {
      await addDoc({ tenant: GLOBEX, chunks: [{ content: CHUNK }] });
      const mine = await addDoc({ chunks: [{ content: `${CHUNK} acme` }] });
      const es = await events('Ai bán mực in?', 'viewer@acme');
      expect(citationsOf(es).map((c) => c.documentId)).toEqual([mine.documentId]);
    });
  });

  describe('Xong khi: golden set (10 questions)', () => {
    type Golden = {
      today: string;
      questions: (
        | { id: string; kind: 'lookup'; question: string; invoice: string }
        | {
            id: string;
            kind: 'aggregate';
            question: string;
            expect: { metric: string; seller: string; from: string; to: string };
            route: QaRoute;
          }
        | { id: string; kind: 'refusal'; question: string; reason: string; route: QaRoute }
      )[];
    };
    type Corpus = {
      invoices: {
        datasetId: string;
        chunks: { kind: 'header' | 'lines'; ordinal: number; content: string }[];
      }[];
    };
    const fixture = <T>(name: string): T =>
      JSON.parse(readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')) as T;
    const expected = (datasetId: string): InvoiceJson =>
      JSON.parse(
        readFileSync(path.join(DATASET, `${datasetId}.expected.json`), 'utf8'),
      ) as InvoiceJson;

    /** The right number, from the dataset's ground truth, without SQL: an independent oracle. */
    function oracle(
      e: { metric: string; seller: string; from: string; to: string },
      ids: string[],
    ) {
      const hits = ids
        .map(expected)
        .filter(
          (i) => i.seller.name.includes(e.seller) && i.issueDate >= e.from && i.issueDate <= e.to,
        );
      const sums = new Map<string, number>();
      for (const i of hits) {
        const value =
          e.metric === 'total'
            ? i.total
            : e.metric === 'vatAmount'
              ? i.vatBreakdown.reduce((s, b) => s + b.amount, 0)
              : 0;
        sums.set(i.currency, (sums.get(i.currency) ?? 0) + value);
      }
      return {
        invoiceCount: hits.length,
        results:
          e.metric === 'invoiceCount'
            ? []
            : [...sums]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([currency, amount]) => ({ currency, amount })),
      };
    }

    it('every citation is a retrieved chunk; out-of-scope questions are refused; numbers are exact', async () => {
      const golden = fixture<Golden>('qa/golden.json');
      const corpus = fixture<Corpus>('retrieval/corpus.json');
      const ids = corpus.invoices.map((i) => i.datasetId);
      const docOf = new Map<string, string>(); // document id -> dataset id
      for (const inv of corpus.invoices) {
        const { documentId } = await addDoc({
          idsFrom: `t5.4/${inv.datasetId}`,
          invoice: expected(inv.datasetId),
          chunks: inv.chunks,
        });
        docOf.set(documentId, inv.datasetId);
      }
      // Traps: the aggregate invoices also exist in another tenant.
      for (const id of ['invoice-0069', 'invoice-0073', 'invoice-0043']) {
        await addDoc({ tenant: GLOBEX, invoice: expected(id) });
      }

      const liveUrl = process.env.QA_GOLDEN_AI_URL;
      const live = liveUrl !== undefined && liveUrl !== '';
      const raw: { id: string; answer: string | null; insufficient: boolean; sources: number }[] =
        [];
      let current = '';
      if (live) {
        const env: Record<string, unknown> = {
          AI_SERVICE_URL: liveUrl,
          AI_SERVICE_TOKEN: process.env.QA_GOLDEN_AI_TOKEN ?? 'dev-only-ai-service-token',
        };
        const http = new HttpQaModel({ get: (k: string) => env[k] } as unknown as ConfigService<
          never,
          true
        >);
        model = {
          classify: (q, today, signal) => http.classify(q, today, signal),
          answer: async (q, sources, signal) => {
            const a = await http.answer(q, sources, signal);
            raw.push({
              id: current,
              answer: a?.answer ?? null,
              insufficient: a?.insufficientEvidence ?? false,
              sources: sources.length,
            });
            return a;
          },
        };
      } else {
        // CI: the model answers what a correct model would (the golden `route`) and cites [1].
        model = {
          classify: (q) => {
            const g = golden.questions.find((x) => x.question === q)!;
            return Promise.resolve(
              g.kind === 'lookup' ? { intent: 'lookup', filter: null } : g.route,
            );
          },
          answer: (_q, sources) => {
            raw.push({
              id: current,
              answer: 'SAMPLE [1]',
              insufficient: false,
              sources: sources.length,
            });
            return Promise.resolve({ insufficientEvidence: false, answer: 'SAMPLE [1]' });
          },
        };
      }

      // The chunks QaService itself retrieved for the question, not a second retrieval (which a
      // real embedder could answer slightly differently).
      const retrievals: RetrievalResult[] = [];
      const original = retrieval.retrieve.bind(retrieval);
      const spy = jest.spyOn(retrieval, 'retrieve').mockImplementation(async (...args) => {
        const result = await original(...args);
        retrievals.push(result);
        return result;
      });

      const rows: Record<string, string>[] = [];
      let invalidDelivered = 0;
      let refusedOutOfScope = 0;
      let exactNumbers = 0;
      for (const g of golden.questions) {
        current = g.id;
        retrievals.length = 0;
        if (live) await new Promise((r) => setTimeout(r, 13_000)); // under 10 requests a minute (free tier)
        const res = await ask(g.question); // one request per question: each one costs quota
        if (live && res.status !== 200) {
          // A real provider fails now and then (Gemini 5xx). Keep measuring the other questions
          // and fail at the end (`unavailable`), instead of losing the whole run.
          rows.push({ id: g.id, expected: g.kind, got: `unavailable (${res.status})` });
          console.log(`${g.id}: unavailable (${res.status})`);
          continue;
        }
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
        const es = parseSse(res.body as string);
        const kind = es[0]!.event;
        const row: Record<string, string> = { id: g.id, expected: g.kind, got: kind };
        if (kind === 'refusal') row.reason = (es[0]!.data as { reason: string }).reason;
        if (g.kind === 'lookup') {
          // Which chunks of the right invoice reached the model (header, lines): a refusal with
          // only the header retrieved is the model being honest, not wrong.
          row.retrievedOfInvoice =
            (retrievals.at(-1)?.chunks ?? [])
              .filter((c) => docOf.get(c.documentId) === g.invoice)
              .map((c) => c.kind)
              .join(' ') || 'none';
        }
        if (g.kind === 'lookup' && kind === 'token') {
          // Every delivered citation must be a chunk retrieved for this very question.
          const retrieved = new Set((retrievals.at(-1)?.chunks ?? []).map((c) => c.chunkId));
          const cited = citationsOf(es);
          if (cited.length === 0 || cited.some((c) => !retrieved.has(c.chunkId!)))
            invalidDelivered += 1;
          row.cites = cited.map((c) => docOf.get(c.documentId) ?? 'other tenant').join(' ');
          row.rightInvoice = String(cited.some((c) => docOf.get(c.documentId) === g.invoice));
        }
        if (g.kind === 'aggregate') {
          const want = oracle(g.expect, ids);
          const got = kind === 'aggregate' ? (es[0]!.data as QaAggregateResult) : undefined;
          const exact =
            got !== undefined &&
            got.invoiceCount === want.invoiceCount &&
            JSON.stringify(got.results) === JSON.stringify(want.results);
          if (exact) exactNumbers += 1;
          row.number = exact
            ? 'exact'
            : `got ${JSON.stringify(got?.results ?? row.reason)} want ${JSON.stringify(want.results)}`;
          // Sources are this tenant's invoices only.
          for (const c of citationsOf(es)) expect(docOf.has(c.documentId)).toBe(true);
        }
        if (g.kind === 'refusal' && row.reason === g.reason) refusedOutOfScope += 1;
        rows.push(row);
        if (live) console.log(JSON.stringify(row)); // as it goes: a later failure keeps these
      }
      spy.mockRestore();
      const rawInvalid = raw.filter(
        // An answer the model flagged as insufficient carries no text to check.
        (r) => r.answer !== null && !r.insufficient && !checkCitations(r.answer, r.sources).ok,
      );

      console.log(
        `\nQ&A golden (${live ? `live model via ${liveUrl}` : 'fake model'}, today ${golden.today})`,
      );
      console.table(rows);
      console.log(
        `invalid citations delivered: ${invalidDelivered}; raw answers refused by the citation check: ${rawInvalid.length} (${rawInvalid.map((r) => r.id).join(' ')}); out of scope refused: ${refusedOutOfScope}/2; exact numbers: ${exactNumbers}/3`,
      );

      // Thresholds written before measuring (T5.4 plan). A question the model could not be
      // reached for is not a measurement: the run fails and has to be repeated.
      expect(rows.filter((r) => r.got!.startsWith('unavailable')).map((r) => r.id)).toEqual([]);
      expect(invalidDelivered).toBe(0);
      expect(refusedOutOfScope).toBe(2);
      expect(exactNumbers).toBe(3);
      if (!live) {
        // With the fake model every lookup is answered (cites [1]) and every aggregate is exact.
        expect(rows.filter((r) => r.expected === 'lookup' && r.got === 'token')).toHaveLength(5);
      }
    }, 600_000);
  });
});
