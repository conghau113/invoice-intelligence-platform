# ADR 0011: Vector search with pgvector inside PostgreSQL

- Status: Accepted
- Date: 2026-10-11

## Context
RAG over a few thousand to tens of thousands of chunks per tenant, with strict tenant isolation already enforced by Postgres RLS.

## Options considered
1. pgvector
2. Dedicated vector DB (Qdrant, Pinecone)
3. Elasticsearch/OpenSearch

## Decision criteria
- Tenant isolation reuse (RLS)
- Hybrid search with full-text
- Ops footprint
- Scale needed

## Decision
pgvector with HNSW (cosine) on `vector(768)` plus Postgres full-text, fused with RRF. 768 dims because HNSW on `vector` supports up to 2,000 dims and the embedding model supports truncation.

## Consequences
- + One database, RLS applies to vectors too
- + Transactions across data and embeddings
- − Very large scale would need a dedicated engine
- − Index build memory on the small demo VM (keep dims modest)

## Revisit when
Millions of vectors per tenant or recall/latency targets not met in T5.6.
