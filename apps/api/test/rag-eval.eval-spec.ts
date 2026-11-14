/**
 * T5.6 RAG evaluation harness: records how the REAL Q&A pipeline answers the 30 golden questions of
 * eval/rag/golden-v1.json. Not a test: it calls real models and is never part of `test:int` or CI
 * (`.eval-spec.ts`, own config `jest.eval.config.js`). Scoring, the judge and the report are in
 * eval/rag (Python); this file only records.
 *
 * Same stack as qa.int-spec.ts: a throw-away Postgres with the real migrations (Testcontainers), the
 * Nest Q&A module as the app role under RLS, and the AI service over HTTP (`HttpQaModel`, the
 * production client). Run the AI service first (`pnpm dev:ai`, with LLM_PROVIDER=gemini and a key,
 * or `fake` for a dry run), then `pnpm eval:rag:run` with RAG_EVAL_AI_URL=http://127.0.0.1:8000.
 *
 * What it does, in order:
 * 1. Loads the 100 `core` invoices (eval/datasets/v1) with their chunks (fixtures/retrieval/corpus.json)
 *    into one tenant, and decoys into another tenant: copies of three invoices and a supplier that
 *    exists only there (Zeta Logistics SAMPLE).
 * 2. Embeds every chunk through the AI service (`/embed`, task document, small batches spaced for
 *    the 30K tokens/minute free tier) and caches vectors in eval/runs/rag (git-ignored): a second
 *    run embeds nothing again. Questions are cached the same way.
 * 3. Retrieval sweep: each lookup question once per seed (ids derived from the seed: ties are
 *    broken by id, T5.3), retrieval only, no generation call.
 * 4. Asks every question `RAG_EVAL_REPEATS` times through `POST /qa/ask`, paced under the free
 *    tier's requests per minute. A 503 is retried once after a minute; a second failure is
 *    recorded as `unavailable` and the run goes on.
 *
 * RAG_EVAL_RESUME=1 keeps answers.jsonl and asks again only the questions recorded as
 * `unavailable` (or not recorded), without a new retrieval sweep. A run that would empty an
 * answers.jsonl holding answers stops unless RAG_EVAL_FRESH=1.
 *
 * Output: eval/runs/rag/answers.jsonl (synthetic text, git-ignored). Nothing is logged but ids and
 * outcomes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { QaAggregateResult, QaCitation } from 'contracts';
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
import { QaService } from '../src/modules/qa/application/qa.service';
import { QaModule } from '../src/modules/qa/qa.module';
import {
  QUERY_EMBEDDER,
  type QueryEmbedder,
  type QueryEmbedding,
} from '../src/modules/search/application/query-embedder.port';
import {
  RetrievalService,
  type RetrievalResult,
} from '../src/modules/search/application/retrieval';
import { HttpQueryEmbedder } from '../src/modules/search/infra/http-query-embedder';
import { parseSse } from './support/sse';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
/** Uploader of every row written here, so cleanup touches nothing else. */
const USER = '00000000-0000-4000-8000-00000000f056';
const TOP_K = 5;
const CANDIDATES = 20;
/** The "today" of the golden file: "tháng 9" means September 2026. */
const TODAY = new Date('2026-11-11T03:00:00Z');
const ROOT = path.join(__dirname, '../../..');
const DATASET = path.join(ROOT, 'eval/datasets/v1/documents');
const GOLDEN = path.join(ROOT, 'eval/rag/golden-v1.json');
const CORPUS = path.join(__dirname, 'fixtures/retrieval/corpus.json');
const RUNS = path.join(ROOT, 'eval/runs/rag');
const ANSWERS = path.join(RUNS, 'answers.jsonl');
/** Chunks per /embed call and pause between calls: 25 chunks every 30 s passed the 30K TPM (T5.3). */
const EMBED_BATCH = 25;
const EMBED_PAUSE_MS = 30_000;
const RETRY_PAUSE_MS = 60_000;

type Golden = {
  today: string;
  questions: { id: string; kind: 'lookup' | 'aggregate' | 'refusal'; question: string }[];
};
type CorpusChunk = { kind: 'header' | 'lines'; ordinal: number; content: string };
type Corpus = { invoices: { datasetId: string; chunks: CorpusChunk[] }[] };
type InvoiceJson = {
  seller: { name: string; taxCode: string };
  buyer: { taxCode: string | null };
  invoiceNo: string;
  series: string;
  issueDate: string;
  currency: string;
  lines: {
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    vatRate: number;
    amount: number;
  }[];
  subtotal: number;
  vatBreakdown: { amount: number }[];
  total: number;
};
type Usage = Record<string, unknown> & { step: string };

function setting(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is not set (see the header)`);
  return value;
}

function intSetting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function uuidFrom(name: string): string {
  const h = createHash('sha256').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const expected = (datasetId: string) =>
  readJson<InvoiceJson>(path.join(DATASET, `${datasetId}.expected.json`));

/** A supplier that exists only in the other tenant: asking about it must end in a refusal. */
const ZETA: { datasetId: string; invoice: InvoiceJson; chunks: CorpusChunk[] } = {
  datasetId: 'zeta-0001',
  invoice: {
    seller: { name: 'Zeta Logistics SAMPLE', taxCode: '0100000001' },
    buyer: { taxCode: null },
    invoiceNo: '0000001',
    series: 'C26TZL',
    issueDate: '2026-09-15',
    currency: 'VND',
    lines: [
      {
        description: 'Warehouse rental SAMPLE',
        quantity: 1,
        unit: 'month',
        unitPrice: 25_000_000,
        vatRate: 10,
        amount: 25_000_000,
      },
    ],
    subtotal: 25_000_000,
    vatBreakdown: [{ amount: 2_500_000 }],
    total: 27_500_000,
  },
  chunks: [
    {
      kind: 'header',
      ordinal: 0,
      content:
        'Hoá đơn / Invoice: C26TZL-0000001 · Người bán / Seller: Zeta Logistics SAMPLE · Ngày / Date: 2026-09-15\nTổng cộng / Total: 27500000 VND',
    },
    {
      kind: 'lines',
      ordinal: 1,
      content:
        'Hoá đơn / Invoice: C26TZL-0000001 · Người bán / Seller: Zeta Logistics SAMPLE\nWarehouse rental SAMPLE · 1 month · 25000000 VND',
    },
  ],
};
const DECOYS = ['invoice-0069', 'invoice-0073', 'invoice-0043'];

/** Vectors by task and text, per embedding model, in the git-ignored run folder. */
class VectorCache {
  private readonly file: string;
  private readonly vectors: Record<string, number[]>;
  constructor(readonly model: string) {
    this.file = path.join(RUNS, `vectors-${model.replace(/[^\w.-]/g, '_')}.json`);
    this.vectors = existsSync(this.file)
      ? readJson<{ vectors: Record<string, number[]> }>(this.file).vectors
      : {};
  }
  key = (task: 'document' | 'query', text: string) => sha(`${task}\n${text}`);
  get(task: 'document' | 'query', text: string): number[] | undefined {
    return this.vectors[this.key(task, text)];
  }
  set(task: 'document' | 'query', text: string, vector: number[]): void {
    this.vectors[this.key(task, text)] = vector;
    writeFileSync(this.file, JSON.stringify({ model: this.model, vectors: this.vectors }));
  }
}

/** The production query embedder, behind the cache: a cached question costs no request. */
class CachingEmbedder implements QueryEmbedder {
  calls = 0;
  constructor(
    private readonly inner: HttpQueryEmbedder,
    private readonly cache: VectorCache,
  ) {}
  async embed(question: string): Promise<QueryEmbedding> {
    const hit = this.cache.get('query', question);
    if (hit) return { model: this.cache.model, vector: hit };
    this.calls += 1;
    const fresh = await this.inner.embed(question);
    if (fresh.model !== this.cache.model) throw new Error('the embedding model changed mid-run');
    this.cache.set('query', question, fresh.vector);
    return fresh;
  }
}

describe('RAG evaluation run (T5.6, real models)', () => {
  const aiUrl = setting('RAG_EVAL_AI_URL');
  const aiToken = setting('RAG_EVAL_AI_TOKEN', 'dev-only-ai-service-token');
  const repeats = intSetting('RAG_EVAL_REPEATS', 3, 1, 5);
  const paceMs = intSetting('RAG_EVAL_PACE_MS', 10_000, 0, 120_000);
  const seeds = setting('RAG_EVAL_SEEDS', 't5.6,s1,s2,s3,s4').split(',');
  const only = process.env.RAG_EVAL_ONLY?.split(',');
  const resume = process.env.RAG_EVAL_RESUME === '1';
  const config: Record<string, unknown> = {
    RAG_TOP_K: TOP_K,
    RAG_CANDIDATES: CANDIDATES,
    NODE_ENV: 'test',
    AI_SERVICE_URL: aiUrl,
    AI_SERVICE_TOKEN: aiToken,
    DEMO_READ_ONLY: false,
  };

  let owner: Pool;
  let pool: Pool;
  let app: NestExpressApplication;
  let retrieval: RetrievalService;
  let cache: VectorCache;
  let embedder: CachingEmbedder;
  /** AI responses seen during one ask: usage of each call, and the model's raw outputs. */
  let seen: { usage: Usage[]; route: unknown; answer: unknown; statuses: number[] } | null = null;
  const datasetOf = new Map<string, string>(); // document id -> dataset id (or other-tenant:…)
  const realFetch = globalThis.fetch;

  const write = (record: Record<string, unknown>) =>
    appendFileSync(ANSWERS, `${JSON.stringify(record)}\n`);

  async function aiPost(pathname: string, body: unknown): Promise<Response> {
    return realFetch(new URL(pathname, aiUrl), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${aiToken}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
  }

  /** Embeds every chunk text not cached yet, in small spaced batches (free-tier TPM). */
  async function embedChunks(texts: string[]): Promise<number> {
    const todo = [...new Set(texts)].filter((t) => !cache.get('document', t));
    let requests = 0;
    for (let start = 0; start < todo.length; start += EMBED_BATCH) {
      const batch = todo.slice(start, start + EMBED_BATCH);
      for (let attempt = 1; ; attempt += 1) {
        const res = await aiPost('/embed', { texts: batch, task: 'document' });
        requests += 1;
        if (res.ok) {
          const body = (await res.json()) as { vectors: number[][]; usage: { model: string } };
          if (body.usage.model !== cache.model) throw new Error('the embedding model changed');
          batch.forEach((t, i) => cache.set('document', t, body.vectors[i]!));
          break;
        }
        await res.body?.cancel();
        if (attempt === 3) throw new Error(`/embed answered ${res.status} three times`);
        console.log(`embed batch ${start / EMBED_BATCH + 1}: HTTP ${res.status}, waiting`);
        await sleep(RETRY_PAUSE_MS);
      }
      console.log(`embedded ${Math.min(start + EMBED_BATCH, todo.length)}/${todo.length} chunks`);
      if (start + EMBED_BATCH < todo.length) await sleep(EMBED_PAUSE_MS);
    }
    return requests;
  }

  /** One approved document, its invoice, lines and chunks (with cached vectors), as the owner. */
  async function insert(
    seed: string,
    tenant: string,
    datasetId: string,
    inv: InvoiceJson,
    chunks: CorpusChunk[],
  ): Promise<void> {
    const ids = (what: string) => uuidFrom(`${seed}/${tenant}/${datasetId}/${what}`);
    const documentId = ids('document');
    const invoiceId = ids('invoice');
    await owner.query(
      `INSERT INTO documents (id, tenant_id, status, source_type, storage_key, content_hash, version, uploaded_by)
       VALUES ($1, $2, 'approved', 'pdf', $3, $4, 1, $5)`,
      [documentId, tenant, `tenant/${tenant}/${documentId}`, randomBytes(32).toString('hex'), USER],
    );
    await owner.query(
      `INSERT INTO invoices (id, tenant_id, document_id, document_version, invoice_no, series, issue_date,
                             seller_tax_code, seller_name, buyer_tax_code, currency, subtotal, vat_amount,
                             total, data, approved_by)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        invoiceId,
        tenant,
        documentId,
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
        [
          tenant,
          invoiceId,
          i + 1,
          l.description,
          l.quantity,
          l.unit,
          l.unitPrice,
          l.vatRate,
          l.amount,
        ],
      );
    }
    for (const c of chunks) {
      await owner.query(
        `INSERT INTO chunks (id, tenant_id, document_id, document_version, invoice_id, kind, ordinal,
                             content, embedding, embedding_model, refs)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8::vector, $9, $10)`,
        [
          ids(`chunk/${c.ordinal}`),
          tenant,
          documentId,
          invoiceId,
          c.kind,
          c.ordinal,
          c.content,
          JSON.stringify(cache.get('document', c.content)),
          cache.model,
          JSON.stringify([{ document_id: documentId, field_path: 'invoiceNo', page: null }]),
        ],
      );
    }
    datasetOf.set(documentId, tenant === ACME ? datasetId : `other-tenant:${datasetId}`);
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
    datasetOf.clear();
  }

  async function load(seed: string, corpus: Corpus): Promise<void> {
    await cleanup();
    for (const inv of corpus.invoices) {
      await insert(seed, ACME, inv.datasetId, expected(inv.datasetId), inv.chunks);
    }
    for (const id of DECOYS) {
      const chunks = corpus.invoices.find((i) => i.datasetId === id)!.chunks;
      await insert(seed, GLOBEX, id, expected(id), chunks);
    }
    await insert(seed, GLOBEX, ZETA.datasetId, ZETA.invoice, ZETA.chunks);
  }

  const shape = (r: RetrievalResult, withContent: boolean) =>
    r.chunks.map((c) => ({
      datasetId: datasetOf.get(c.documentId) ?? 'unknown',
      kind: c.kind,
      ordinal: c.ordinal,
      vectorRank: c.vectorRank,
      ftsRank: c.ftsRank,
      ...(withContent ? { content: c.content } : {}),
    }));

  beforeAll(async () => {
    owner = new Pool({ connectionString: setting('DATABASE_OWNER_URL'), max: 2 });
    pool = new Pool({ connectionString: setting('DATABASE_URL'), max: 6 });

    // Records what the AI service answered (usage, raw outputs), without changing any response.
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const step = url.pathname.slice(1);
      const watched =
        url.origin === new URL(aiUrl).origin && ['classify', 'answer', 'embed'].includes(step);
      let res: Response;
      try {
        res = await realFetch(input, init);
      } catch (err) {
        // No response: the API's own timeout (30 s per model call) or an abort. Recorded as -1, so
        // the report tells it apart from a 503 the AI service answered (provider overloaded).
        if (seen !== null && watched) seen.statuses.push(-1);
        throw err;
      }
      if (seen !== null && watched) {
        seen.statuses.push(res.status);
        if (res.ok) {
          const body = (await res.clone().json()) as {
            output?: unknown;
            usage?: Record<string, unknown>;
          };
          if (body.usage) seen.usage.push({ step, ...body.usage });
          if (step === 'classify') seen.route = body.output ?? null;
          if (step === 'answer') seen.answer = body.output ?? null;
        }
      }
      return res;
    };

    @Global()
    @Module({
      providers: [
        { provide: DB, useValue: drizzle(pool, { schema }) },
        TenantDbService,
        { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      ],
      exports: [DB, TenantDbService, ConfigService],
    })
    class RealDbModule {}

    // Which embedding model the AI service runs: one short request, before reading the cache.
    const probe = await aiPost('/embed', { texts: ['SAMPLE'], task: 'query' });
    if (!probe.ok) throw new Error(`AI service /embed answered ${probe.status}: is it running?`);
    cache = new VectorCache(((await probe.json()) as { usage: { model: string } }).usage.model);
    embedder = new CachingEmbedder(
      // The embedder only calls `config.get(key)`; a full ConfigService would need the Nest
      // config module and its env validation, which this harness does not load.
      new HttpQueryEmbedder({ get: (k: string) => config[k] } as unknown as ConfigService<
        never,
        true
      >),
      cache,
    );

    const mod = await Test.createTestingModule({
      imports: [RealDbModule, QaModule],
      providers: [
        {
          provide: TOKEN_VERIFIER,
          useValue: {
            verify: () =>
              Promise.resolve({
                sub: USER,
                organization: ['acme'],
                realm_access: { roles: ['accountant'] },
              }),
          },
        },
        { provide: TENANT_DIRECTORY, useValue: { idForAlias: () => Promise.resolve(ACME) } },
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
    retrieval = mod.get(RetrievalService);
    mod.get(QaService).now = () => TODAY;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await cleanup();
    await app?.close();
    await Promise.all([owner?.end(), pool?.end()]);
  });

  const ask = (question: string) =>
    request(app.getHttpServer())
      .post('/qa/ask')
      .set('authorization', 'Bearer eval')
      .send({ question })
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => done(null, text));
      });

  it('records the golden set', async () => {
    const golden = readJson<Golden>(GOLDEN);
    expect(golden.today).toBe(TODAY.toISOString().slice(0, 10));
    const questions = golden.questions.filter((q) => !only || only.includes(q.id));
    const corpus = readJson<Corpus>(CORPUS);
    mkdirSync(RUNS, { recursive: true });
    // Resume: keep the file and ask again only what is missing or was `unavailable` (the provider
    // failed twice). The scorer keeps the last record of each repeat and question.
    const previous =
      resume && existsSync(ANSWERS)
        ? readFileSync(ANSWERS, 'utf8')
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map(
              (l) =>
                JSON.parse(l) as { type: string; repeat?: number; id?: string; outcome?: string },
            )
        : [];
    const answered = new Set(
      previous
        .filter((r) => r.type === 'ask' && r.outcome !== 'unavailable')
        .map((r) => `r${r.repeat}/${r.id}`),
    );
    // A fresh run empties the file. The committed hand labels and the judgements are keyed on its
    // answers, so a run that holds answers is only replaced on purpose.
    if (!resume) {
      const holdsAnswers =
        existsSync(ANSWERS) && readFileSync(ANSWERS, 'utf8').includes('"type":"ask"');
      if (holdsAnswers && process.env.RAG_EVAL_FRESH !== '1') {
        throw new Error(
          'answers.jsonl already holds a run: RAG_EVAL_RESUME=1 to complete it, RAG_EVAL_FRESH=1 to replace it',
        );
      }
      writeFileSync(ANSWERS, '');
    }

    const texts = [
      ...corpus.invoices.flatMap((i) => i.chunks.map((c) => c.content)),
      ...ZETA.chunks.map((c) => c.content),
    ];
    const embedRequests = await embedChunks(texts);
    const swept = previous.some((r) => r.type === 'meta');
    write({
      type: swept ? 'resume' : 'meta',
      startedAt: new Date().toISOString(),
      today: golden.today,
      repeats,
      seeds,
      only: only ?? null,
      topK: TOP_K,
      candidates: CANDIDATES,
      embedModel: cache.model,
      chunkEmbedRequests: embedRequests,
    });

    // 1. Retrieval sweep over seeds (no generation call; question vectors come from the cache).
    const lookups = questions.filter((q) => q.kind === 'lookup');
    for (const seed of swept ? [] : seeds) {
      await load(seed, corpus);
      for (const q of lookups) {
        const r = await retrieval.retrieve(ACME, q.question);
        const retrieved = shape(r, false);
        write({ type: 'retrieval', seed, id: q.id, retrieved });
        if (retrieved.some((c) => c.datasetId.startsWith('other-tenant'))) {
          throw new Error(`tenant leak in retrieval for ${q.id}`); // RLS and the explicit filter failed
        }
      }
      console.log(`seed ${seed}: ${lookups.length} lookups retrieved`);
    }

    // 2. The asks, on the first seed's ids.
    await load(seeds[0]!, corpus);
    const retrievals: RetrievalResult[] = [];
    const original = retrieval.retrieve.bind(retrieval);
    jest.spyOn(retrieval, 'retrieve').mockImplementation(async (...args) => {
      const result = await original(...args);
      retrievals.push(result);
      return result;
    });

    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const q of questions) {
        if (answered.has(`r${repeat}/${q.id}`)) continue;
        let attempts = 0;
        let res: request.Response | undefined;
        const started = Date.now();
        const current = {
          usage: [] as Usage[],
          route: undefined as unknown,
          answer: undefined as unknown,
          statuses: [] as number[],
        };
        seen = current;
        retrievals.length = 0;
        while (attempts < 2) {
          attempts += 1;
          await sleep(paceMs); // under the free tier's 15 requests a minute (two calls per lookup)
          res = await ask(q.question);
          if (res.status !== 503 || attempts === 2) break;
          console.log(`r${repeat}/${q.id}: 503, retrying in ${RETRY_PAUSE_MS / 1000} s`);
          await sleep(RETRY_PAUSE_MS);
        }
        const base = {
          type: 'ask',
          repeat,
          id: q.id,
          question: q.question,
          attempts,
          status: res!.status,
          ms: Date.now() - started,
          aiStatuses: current.statuses,
          usage: current.usage,
          route: current.route ?? null,
          rawAnswer: current.answer ?? null,
          retrieved: retrievals.length ? shape(retrievals.at(-1)!, true) : [],
        };
        if (res!.status !== 200) {
          write({ ...base, outcome: 'unavailable' });
          console.log(`r${repeat}/${q.id}: unavailable (${res!.status})`);
          continue;
        }
        const events = parseSse(res!.body as string);
        const first = events[0]!;
        const citations =
          (
            events.find((e) => e.event === 'citations')?.data as
              { citations: QaCitation[] } | undefined
          )?.citations ?? [];
        const record = {
          ...base,
          outcome:
            first.event === 'token'
              ? 'answer'
              : first.event === 'aggregate'
                ? 'aggregate'
                : 'refusal',
          reason: first.event === 'refusal' ? (first.data as { reason: string }).reason : null,
          answer: events
            .filter((e) => e.event === 'token')
            .map((e) => (e.data as { text: string }).text)
            .join(''),
          aggregate: first.event === 'aggregate' ? (first.data as QaAggregateResult) : null,
          citations: citations.map((c) => {
            const chunk = c.chunkId
              ? retrievals.at(-1)?.chunks.find((x) => x.chunkId === c.chunkId)
              : undefined;
            return {
              n: c.n,
              datasetId: datasetOf.get(c.documentId) ?? 'unknown',
              chunk: chunk ? `${chunk.kind}#${chunk.ordinal}` : null,
            };
          }),
        };
        write(record);
        console.log(
          `r${repeat}/${q.id}: ${record.outcome}${record.reason ? ` ${record.reason}` : ''} ` +
            `(${record.citations.length} citations, ${attempts} attempt(s), ${record.ms} ms)`,
        );
      }
    }
    // Embedding requests made outside an ask (chunks, the model probe, the retrieval sweep) are
    // not in any ask's usage: recorded here so the report counts every request of the run.
    write({
      type: 'end',
      endedAt: new Date().toISOString(),
      chunkEmbedRequests: embedRequests,
      questionEmbedRequests: embedder.calls,
      probeEmbedRequests: 1,
    });
    console.log(
      `done: ${embedRequests} chunk embed requests, ${embedder.calls} question embed requests`,
    );
  });
});
