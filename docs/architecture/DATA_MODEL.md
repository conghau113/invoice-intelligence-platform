# Data Model

> PostgreSQL 17 + pgvector. Drizzle ORM migrations. All business tables carry `tenant_id` and are protected by Row-Level Security (ADR 0003). Money is stored as `bigint` in the currency's minor unit (VND has no minor unit; USD in cents). Timestamps are `timestamptz` (UTC).

## ERD

```mermaid
erDiagram
  tenants ||--o{ memberships : has
  users ||--o{ memberships : has
  tenants ||--o{ documents : owns
  documents ||--o{ extractions : "has versions"
  documents ||--o| invoices : "approved as"
  invoices ||--o{ invoice_lines : contains
  extractions ||--o{ field_corrections : "corrected by human"
  invoices ||--o{ chunks : "indexed as"
  tenants ||--o{ audit_logs : records
  users ||--o{ notifications : receives

  tenants { uuid id PK; text alias UK; text name; timestamptz created_at }
  users { uuid id PK; text email; text display_name; timestamptz created_at }
  memberships { uuid tenant_id FK; uuid user_id FK; text role }
  documents { uuid id PK; uuid tenant_id; text status; text source_type; text storage_key; char64 content_hash; int version; uuid uploaded_by; timestamptz created_at }
  extractions { uuid id PK; uuid tenant_id; uuid document_id FK; int document_version; jsonb data; jsonb warnings; text model; text prompt_version; int input_tokens; int output_tokens; int latency_ms; numeric cost_usd; timestamptz created_at }
  field_corrections { uuid id PK; uuid tenant_id; uuid extraction_id FK; text field_path; jsonb ai_value; jsonb human_value }
  invoices { uuid id PK; uuid tenant_id; uuid document_id FK; text invoice_no; text series; date issue_date; text seller_tax_code; text seller_name; text buyer_tax_code; char3 currency; bigint subtotal; bigint vat_amount; bigint total; uuid approved_by; int row_version }
  invoice_lines { uuid id PK; uuid tenant_id; uuid invoice_id FK; int line_no; text description; numeric quantity; bigint unit_price; numeric vat_rate; bigint amount }
  chunks { uuid id PK; uuid tenant_id; uuid invoice_id FK; text kind; text content; tsvector content_tsv; vector768 embedding; jsonb refs }
  audit_logs { bigint id PK; uuid tenant_id; uuid actor_id; text action; text entity; uuid entity_id; jsonb meta; inet ip; timestamptz at }
  notifications { uuid id PK; uuid tenant_id; uuid user_id; text type; jsonb payload; timestamptz read_at }
```

## Tables

### tenants, users, memberships
- A tenant maps 1:1 to a Keycloak Organization: `tenants.id` IS the organization id (fixed in the realm file) and `alias` is what the token's `organization` claim carries. `users.id` IS the Keycloak `sub`, so `AuthUser.userId` is the key everywhere (`actor_id`, `uploaded_by`, `approved_by`, `notifications.user_id`) and needs no mapping. Users are created lazily on first login from token claims (T1.7).
- `users` is a global identity table (no `tenant_id`): RLS shows a request only users that are members of the current tenant.
- `memberships.role` mirrors the Keycloak role for display; **authorization decisions use the token**, the table is for listing members.

### documents
- `status` follows the state machine in `ARCHITECTURE.md §8`; only `DocumentStateMachine` writes it.
- `UNIQUE (tenant_id, content_hash)` → duplicate uploads return the existing row (idempotency).
- `version` increments when a document is reopened after approval.
- Indexes: `(tenant_id, status, created_at DESC)` for the list page; `(tenant_id, content_hash)` unique.

### extractions
- Append-only: every extraction run is a new row (model, prompt version, tokens, cost, latency) → cost reporting and A/B comparison come for free.
- `data` holds the Invoice JSON exactly as validated by `packages/contracts`.

### field_corrections
- One row per field the reviewer changed. Feeds the "human correction rate" metric (T4.6) — an online signal that complements the offline eval.

### invoices, invoice_lines
- Written only on approval. `row_version` enables optimistic concurrency (T3.5).
- Indexes: `(tenant_id, issue_date)`, `(tenant_id, seller_tax_code)` for aggregate questions.

### chunks
- `embedding vector(768)` with HNSW (`vector_cosine_ops`); `content_tsv` with GIN. 768 dims because pgvector's HNSW index supports up to 2,000 dimensions for the `vector` type and Gemini embeddings support Matryoshka truncation (ADR 0011).
- `refs` lists `{document_id, page, field_path}` used for citations.

### audit_logs
- Append-only; never stores document content or extracted PII values — only ids and action names.

## Row-Level Security (summary)

```sql
CREATE FUNCTION app_current_tenant() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
```

The application connects as a role that does not own the tables and is not `BYPASSRLS`. Each request runs in a transaction that starts with `SELECT set_config('app.tenant_id', $1, true)` (transaction-local, safe with connection pooling). Migrations run as the owner role.

`NULLIF(..., '')` is deliberate: after a transaction that used `set_config(..., true)`, a pooled connection reports `''` (not NULL) and `''::uuid` would raise an error instead of returning zero rows. The real definitions, the app role `invoice_app`, grants (`audit_logs` is `SELECT, INSERT` only) and the alias lookup `app_resolve_tenant(alias)` (an ordinary function plus a narrow `tenant_resolve` SELECT policy, no elevated privileges) live in `apps/api/drizzle/0001_rls.sql` and `0002_resolve_tenant_policy.sql`. Drizzle cannot emit `FORCE ROW LEVEL SECURITY`, so every new business table copies the pattern from that file; `apps/api/test/db.int-spec.ts` fails if a public table lacks forced RLS or a policy.
