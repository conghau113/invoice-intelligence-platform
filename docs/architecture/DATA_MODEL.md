# Data Model

> PostgreSQL 17 + pgvector. Drizzle ORM migrations. All business tables carry `tenant_id` and are protected by Row-Level Security (ADR 0003). Money is stored as `bigint` in the currency's minor unit (VND has no minor unit; USD in cents). Timestamps are `timestamptz` (UTC).

## ERD

```mermaid
erDiagram
  tenants ||--o{ memberships : has
  users ||--o{ memberships : has
  tenants ||--o{ documents : owns
  documents ||--o{ extractions : "has versions"
  documents ||--o{ invoices : "approved as, one per version"
  invoices ||--o{ invoice_lines : contains
  extractions ||--o{ field_corrections : "corrected by human"
  invoices ||--o{ chunks : "indexed as"
  tenants ||--o{ audit_logs : records
  users ||--o{ notifications : receives

  tenants { uuid id PK; text alias UK; text name; timestamptz created_at }
  users { uuid id PK; text email; text display_name; timestamptz created_at }
  memberships { uuid tenant_id FK; uuid user_id FK; text role }
  documents { uuid id PK; uuid tenant_id; text status; text failure_code; text source_type; text storage_key; char64 content_hash; int version; uuid uploaded_by; timestamptz created_at }
  extractions { uuid id PK; uuid tenant_id; uuid document_id FK; int document_version; text source; jsonb data; jsonb warnings; text model; text prompt_version; int input_tokens; int output_tokens; int latency_ms; numeric cost_usd; timestamptz created_at }
  field_corrections { uuid id PK; uuid tenant_id; uuid extraction_id FK; int document_version; text field_path; jsonb ai_value; jsonb human_value; timestamptz created_at }
  invoices { uuid id PK; uuid tenant_id; uuid document_id FK; text invoice_no; text series; date issue_date; text seller_tax_code; text seller_name; text buyer_tax_code; char3 currency; bigint subtotal; bigint vat_amount; bigint total; int document_version; jsonb data; jsonb warnings; uuid approved_by; timestamptz approved_at }
  invoice_lines { uuid id PK; uuid tenant_id; uuid invoice_id FK; int line_no; text description; numeric quantity; text unit; bigint unit_price; numeric vat_rate; bigint amount }
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
- `version` increments when a document is reopened after approval, and only then. Approving keeps it.
- `failure_code` is the reason (a code from `DOCUMENT_FAILURE_CODES` in `packages/contracts/src/error-codes.ts`, never content) while `status = 'failed'`, otherwise `NULL`. A code from the AI service that is not on the list is replaced by a generic one: `EXTRACTION_FAILED` when the answer is final, `EXTRACTION_RETRIES_EXHAUSTED` when the attempts ran out. `DocumentStateMachine` writes it in the same `UPDATE` as `status`, so the detail page reads it without scanning `audit_logs`.
- Indexes: `(tenant_id, status, created_at DESC)` for the list page; `(tenant_id, content_hash)` unique.

### extractions
- Append-only (the app role has no `UPDATE`/`DELETE`) and **at most one row per `(document_id, document_version)`**: that unique key makes the worker idempotent, because a job delivered twice inserts the same row twice and the second insert does nothing. Reopening does not extract again, so a reopened document keeps the row of its earlier version and `document_version` can be lower than `documents.version`. Comparing models or prompts (A/B) is done by `eval/`, not by storing several runs per version here.
- `source` (`xml | pdf | image`) says which path produced `data`. `model`, `prompt_version`, token counts and `cost_usd` are `NULL` on the XML path (no LLM); `latency_ms` is always set (measured by the worker when the AI service reports none).
- `data` holds the Invoice JSON exactly as validated by `packages/contracts`, and is validated again when it is read (`GET /documents/:id`). `warnings` is stored as returned by the AI service.

### field_corrections
- One row per field the reviewer changed. Feeds the "human correction rate" metric (T4.6) — an online signal that complements the offline eval.
- Computed by the API from the stored extraction, never taken from the client. `field_path` uses the `fieldMeta` grammar; a NULL value means that side had no value (`buyer.taxCode`, or a line added or removed). Lines are compared by position, so removing a line in the middle also reports the lines after it. Values are document content: never log them.
- `UNIQUE (extraction_id, document_version, field_path)`. Index `(tenant_id, field_path)` for the metric. Each field of a line added or removed is its own row, so one added line counts as six.
- Every approval diffs the whole invoice against the extraction, so a later version repeats what an earlier one changed. Rows are never removed. **The metric reads the view `current_field_corrections`** (see below), which counts each document once: a field changed at version 1 and put back at version 2 no longer counts, and a reopened document counts nothing until it is approved again.

### invoices, invoice_lines
- Written only on approval, in one transaction with the status change, `field_corrections` and audit. The app role has `SELECT, INSERT` only. `UNIQUE (document_id, document_version)`: at most one invoice per version of a document.
- **These tables are history, not "what is approved".** Reopening keeps the rows, because the form reopens with those values and what was approved stays on record. Anything that asks what is approved now (Q&A in T5.x, aggregates) **must read the views `current_invoices` and `current_invoice_lines`**; reading the tables directly counts old versions too. The rule behind the views: a row is current when `document_version = documents.version`. A row at version N is written only by approving version N and reopening always bumps the version, so no status check is needed.
- The `current_*` views use `security_invoker`, so the caller's RLS applies to the tables below them. The RLS gate in `test/support/rls.ts` refuses any view in `public` without it, or granted to `PUBLIC`.
- **A migration that changes these tables must also recreate the views.** Postgres expands `SELECT *` once, when the view is created: a column added later is missing from the view until then (`review.int-spec.ts` fails on this), and dropping or retyping a column fails while a view reads it. drizzle-kit does not know the views.
- Because rows are never removed, a document can reach version 20 at most (`MAX_DOCUMENT_VERSION`), which bounds what one account can store by looping reopen and approve.
- The optimistic-concurrency token is `documents.version`, sent as `If-Match` (API.md), because an invoice row does not exist before the first approval. Approving does not bump the version, so the check is version **and** status, both under the row lock in `DocumentStateMachine`: a stale version gives `VERSION_CONFLICT`, an already approved document gives `INVALID_DOCUMENT_TRANSITION`, both `409`.
- `data` is the whole approved Invoice incl. `fieldMeta`, validated when written and when read; a `fieldMeta` entry is kept only if the stored extraction holds the same meta and the path exists on the invoice, so a client cannot invent evidence: the review screen and chunking (T5.1) need fields and pages the columns do not hold. The columns are derived from it in the same insert, for aggregate questions. `warnings` are the rule warnings accepted at approval (they never block it, PRD 5.4).
- `invoices`, `invoice_lines` and `field_corrections` reference their parent with a composite foreign key that includes `tenant_id`: an ordinary FK check ignores RLS and would accept another tenant's id.
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
