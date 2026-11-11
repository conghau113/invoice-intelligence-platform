import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql, type SQL } from 'drizzle-orm';
import type { Env } from '../../../config/env.schema';
import { TenantDbService, type Tx } from '../../../db/tenant-db.service';
import type { ChunkRef } from '../domain/ai-index-response';
import { fuse, type Ranked } from '../domain/rrf';
import { QUERY_EMBEDDER, type QueryEmbedder, type QueryEmbedding } from './query-embedder.port';

/** A chunk as read from `chunks`. `refs` was checked by zod before it was written (T5.2). */
export type ChunkRow = {
  id: string;
  document_id: string;
  document_version: number;
  invoice_id: string;
  kind: 'header' | 'lines';
  ordinal: number;
  content: string;
  refs: ChunkRef[];
};
type VectorRow = ChunkRow & { distance: number };
type FullTextRow = ChunkRow & { score: number };

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  documentVersion: number;
  invoiceId: string;
  kind: 'header' | 'lines';
  ordinal: number;
  content: string;
  refs: ChunkRef[];
  /** RRF score: what the order is based on. */
  score: number;
  /** 1-based rank in the vector list and its cosine distance (0 = same direction), or null. */
  vectorRank: number | null;
  vectorDistance: number | null;
  /** 1-based rank in the full-text list and its score (sum of the IDF of matched words), or null. */
  ftsRank: number | null;
  ftsScore: number | null;
};

export type RetrievalResult = {
  /** Model of the question's vector: only chunks embedded by the same model were compared. */
  model: string;
  topK: number;
  /** How many candidates each list was asked for. */
  candidates: number;
  chunks: RetrievedChunk[];
};

/** A question, not a document: long enough for any real question, short enough to embed in one go. */
export const MAX_QUESTION_CHARS = 1000;
/** Distinct words of a question used by full-text (each one costs a GIN count for its weight). */
export const MAX_QUERY_TERMS = 32;
export const MAX_TOP_K = 20;

/** hnsw.ef_search default; never set lower, and at least the number of candidates asked for. */
const MIN_EF_SEARCH = 40;

/**
 * Which chunks may be returned at all, shared by both lists: the tenant's, of a document that is
 * approved, and of that document's CURRENT version. Reopening deletes the chunks (T5.2) and bumps
 * the version; if that delete ever failed or a late job wrote an old version, the version check
 * still keeps them out. The tenant is filtered here even though RLS does it too (ADR 0003, defense
 * in depth): either layer alone keeps other tenants out.
 */
const retrievable = (tenantId: string): SQL => sql`
  c.tenant_id = ${tenantId}
  AND d.tenant_id = ${tenantId}
  AND d.status = 'approved'
  AND c.document_version = d.version`;

const COLUMNS = sql`c.id, c.document_id, c.document_version, c.invoice_id, c.kind, c.ordinal,
  c.content, c.refs`;

/**
 * Nearest chunks by cosine distance, through the HNSW index. The planner keeps the index only for
 * `ORDER BY embedding <=> $v LIMIT n` with nothing else in the ORDER BY, so ties are left as they are.
 * The tenant, status and version conditions are filters applied while walking the index: without
 * an iterative scan, HNSW hands over `ef_search` candidates from the WHOLE table and a small tenant
 * could get fewer than n rows. `strict_order` keeps scanning until n rows pass, in exact order.
 * Both settings are SET LOCAL: they end with this transaction.
 */
export const hnswSettings = (limit: number): SQL => sql`
  SELECT set_config('hnsw.ef_search', ${String(Math.max(MIN_EF_SEARCH, limit))}, true),
         set_config('hnsw.iterative_scan', 'strict_order', true)`;

/** The nearest-neighbour query alone (exported so that a test can EXPLAIN it). */
export function vectorSql(tenantId: string, query: QueryEmbedding, limit: number): SQL {
  const vector = JSON.stringify(query.vector);
  return sql`
    SELECT ${COLUMNS}, c.embedding <=> ${vector}::vector AS distance
      FROM chunks c
      JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
     WHERE ${retrievable(tenantId)}
       AND c.embedding_model = ${query.model}
     ORDER BY c.embedding <=> ${vector}::vector
     LIMIT ${limit}`;
}

export async function vectorCandidates(
  tx: Tx,
  tenantId: string,
  query: QueryEmbedding,
  limit: number,
): Promise<VectorRow[]> {
  await tx.execute(hnswSettings(limit));
  const { rows } = await tx.execute<VectorRow>(vectorSql(tenantId, query, limit));
  return rows;
}

/**
 * Chunks sharing words with the question, ranked by the sum of the IDF of the words they contain.
 *
 * Why not `ts_rank_cd`: Postgres ranks by how often and how close the words occur, with no notion
 * of how rare a word is. Every chunk repeats the bilingual labels ("Hoá đơn / Invoice", "Đơn giá"
 * on each line), so a question saying "hoá đơn" ranked line chunks full of labels above the one
 * chunk holding the invoice number (golden set, seed t5.3: full-text hit@5 4/10 with `ts_rank_cd`,
 * 9/10 with IDF; T5.3 task notes). IDF is BM25's (Lucene): ln(1 + (N - df + 0.5) / (df + 0.5)),
 * N = the tenant's chunks, df = those containing the word. A label in every chunk weighs about
 * 0.002, an item code in one chunk about ln(N); it stays positive for a tenant with a single
 * invoice. No term frequency or length normalisation: chunks are small and of similar size.
 *
 * Candidates are the chunks containing ANY of the question's words (a question in full sentences
 * almost never has all its words in one chunk). Each word is its own `plainto_tsquery` over one
 * lexeme of `to_tsvector`, so the question is never parsed as tsquery syntax; the OR query is
 * rebuilt from those parsed terms. At most MAX_QUERY_TERMS distinct words are used: each costs one
 * GIN count for its df. Config 'simple' like `content_tsv` (no stemming, accents kept: "ca phe"
 * does not match "cà phê"). A question with no word at all matches nothing. N and df count the
 * tenant's chunks (GIN and btree, RLS on top) without the status/version join: stale chunks are
 * rare and only nudge a weight.
 */
export async function fullTextCandidates(
  tx: Tx,
  tenantId: string,
  question: string,
  limit: number,
): Promise<FullTextRow[]> {
  const { rows } = await tx.execute<FullTextRow>(sql`
    WITH terms AS (
      SELECT plainto_tsquery('simple', lexeme) AS term
        FROM unnest(tsvector_to_array(to_tsvector('simple', ${question}))) AS lexeme
       LIMIT ${MAX_QUERY_TERMS}
    ),
    total AS (SELECT count(*)::float8 AS n FROM chunks WHERE tenant_id = ${tenantId}),
    weights AS (
      SELECT terms.term,
             ln(1 + (total.n - df.n + 0.5) / (df.n + 0.5)) AS idf
        FROM terms
       CROSS JOIN total
       CROSS JOIN LATERAL (
         SELECT count(*)::float8 AS n
           FROM chunks x
          WHERE x.tenant_id = ${tenantId} AND x.content_tsv @@ terms.term
       ) df
    ),
    q AS (
      -- term::text is Postgres's own quoted output; parenthesised so a phrase term stays whole.
      SELECT string_agg('(' || term::text || ')', ' | ')::tsquery AS query FROM terms
    )
    SELECT ${COLUMNS},
           (SELECT sum(w.idf) FROM weights w WHERE c.content_tsv @@ w.term) AS score
      FROM q, chunks c
      JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
     WHERE ${retrievable(tenantId)}
       AND c.content_tsv @@ q.query
     ORDER BY score DESC, c.id
     LIMIT ${limit}`);
  return rows;
}

const asError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error('Retrieval failed');

const ranked = <T extends ChunkRow>(rows: T[]): Ranked<T>[] =>
  rows.map((r) => ({ id: r.id, item: r }));

/**
 * Hybrid retrieval (T5.3, ADR 0011, AI_PIPELINE.md §7): full-text and vector candidates, fused with
 * RRF. Full-text needs no vector, so it runs while the AI service embeds the question; the vector
 * query starts when the vector arrives. Each list reads in its own short tenant transaction (RLS),
 * on its own pooled connection, and no transaction is open while waiting on HTTP. Used by the debug
 * route and by Q&A (T5.4). Never logs the question or a chunk.
 */
@Injectable()
export class RetrievalService {
  private readonly defaultTopK: number;
  private readonly candidates: number;

  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(QUERY_EMBEDDER) private readonly embedder: QueryEmbedder,
    config: ConfigService<Env, true>,
  ) {
    this.defaultTopK = config.get('RAG_TOP_K', { infer: true });
    this.candidates = config.get('RAG_CANDIDATES', { infer: true });
  }

  async retrieve(
    tenantId: string,
    question: string,
    options: { topK?: number } = {},
  ): Promise<RetrievalResult> {
    // The debug route validates both; Q&A (T5.4) calls this directly, so the service bounds them too.
    const topK = Math.min(Math.max(Math.trunc(options.topK ?? this.defaultTopK), 1), MAX_TOP_K);
    const candidates = Math.max(this.candidates, topK);
    question = question.slice(0, MAX_QUESTION_CHARS);

    const [fullText, vector] = await Promise.allSettled([
      this.tenantDb.run(tenantId, (tx) => fullTextCandidates(tx, tenantId, question, candidates)),
      this.embedder.embed(question).then(async (query) => ({
        query,
        rows: await this.tenantDb.run(tenantId, (tx) =>
          vectorCandidates(tx, tenantId, query, candidates),
        ),
      })),
    ]);
    // allSettled, not all: a failed embedding must not leave the full-text promise unobserved.
    // QueryEmbeddingUnavailableError goes up as it is (503 AI_SERVICE_UNAVAILABLE); a DB error too.
    if (vector.status === 'rejected') throw asError(vector.reason);
    if (fullText.status === 'rejected') throw asError(fullText.reason);

    const vectorRows = vector.value.rows;
    const ftsRows = fullText.value;
    const distance = new Map(vectorRows.map((r) => [r.id, r.distance]));
    const ftsScore = new Map(ftsRows.map((r) => [r.id, r.score]));
    const fused = fuse<ChunkRow>([ranked(vectorRows), ranked(ftsRows)], topK);

    return {
      model: vector.value.query.model,
      topK,
      candidates,
      chunks: fused.map(({ item, score, ranks: [vectorRank, ftsRank] }) => ({
        chunkId: item.id,
        documentId: item.document_id,
        documentVersion: item.document_version,
        invoiceId: item.invoice_id,
        kind: item.kind,
        ordinal: item.ordinal,
        content: item.content,
        refs: item.refs,
        score,
        vectorRank: vectorRank ?? null,
        vectorDistance: distance.get(item.id) ?? null,
        ftsRank: ftsRank ?? null,
        ftsScore: ftsScore.get(item.id) ?? null,
      })),
    };
  }
}
