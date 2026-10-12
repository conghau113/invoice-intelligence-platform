# ADR 0016: Data access with Drizzle ORM and SQL migrations

- Status: Accepted
- Date: 2026-10-11

## Context
Need typed queries, explicit SQL for RLS, pgvector and full-text, and reviewable migrations.

## Options considered
1. Prisma
2. TypeORM
3. Drizzle
4. Raw SQL (pg)

## Decision criteria
- SQL transparency (RLS, vector ops)
- Type safety
- Migration review
- Maturity

## Decision
Drizzle ORM with drizzle-kit generated SQL migrations committed to the repo; raw SQL where Drizzle lacks support (policies, HNSW).

## Consequences
- + SQL-like API, easy to reason about RLS and transactions
- + Migrations are plain SQL files
- − Younger ecosystem than Prisma/TypeORM
- − Pre-1.0 versioning: pin versions

## Revisit when
If Drizzle blocks a needed feature, fall back to raw SQL in that module.
