import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables and indexes only. Roles, grants, RLS and policies are hand-written in
// drizzle/0001_rls.sql because Drizzle cannot express FORCE ROW LEVEL SECURITY.

/** A tenant is a Keycloak Organization: `id` IS the organization id (fixed in the realm file). */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  alias: text('alias').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Global identity (no tenant_id). `id` is the Keycloak `sub`, so AuthUser.userId is the key. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email'),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Display/listing only; authorization decisions use the token (DATA_MODEL.md). */
export const memberships = pgTable(
  'memberships',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index('memberships_user_id_idx').on(t.userId),
    check('memberships_role_check', sql`${t.role} in ('tenant_admin', 'accountant', 'viewer')`),
  ],
);

/** Append-only: the app role has no UPDATE/DELETE. Ids and action names only, never content. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Keycloak sub of the actor; null for system actions. No FK: audit must not depend on users.
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: uuid('entity_id'),
    meta: jsonb('meta'),
    ip: inet('ip'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_tenant_at_idx').on(t.tenantId, t.at.desc())],
);

/**
 * `status` follows ARCHITECTURE.md section 8 and is written only by DocumentStateMachine. The
 * CHECK lists below mirror domain/document-status.ts (the domain owns the transitions; the
 * database only guarantees the value set). `uploaded_by` has no FK on purpose, like audit
 * `actor_id`: users are provisioned lazily and a document must not depend on that row.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    status: text('status').notNull().default('uploaded'),
    sourceType: text('source_type').notNull(),
    storageKey: text('storage_key').notNull(),
    contentHash: char('content_hash', { length: 64 }).notNull(),
    // Incremented when an approved document is reopened.
    version: integer('version').notNull().default(1),
    // Why the document is `failed` (UPPER_SNAKE code, never content); null in every other status.
    // Written only by DocumentStateMachine together with `status`.
    failureCode: text('failure_code'),
    uploadedBy: uuid('uploaded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('documents_tenant_hash_unique').on(t.tenantId, t.contentHash),
    // Target of the composite foreign keys below: a child row cannot point at another tenant's parent.
    unique('documents_id_tenant_unique').on(t.id, t.tenantId),
    // The list page (GET /documents) orders by (created_at, id); `id` is the tie-breaker that keeps pages deterministic.
    index('documents_tenant_created_idx').on(t.tenantId, t.createdAt.desc(), t.id.desc()),
    index('documents_tenant_status_created_idx').on(
      t.tenantId,
      t.status,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    check(
      'documents_status_check',
      sql`${t.status} in ('uploaded', 'queued', 'processing', 'needs_review', 'approved', 'rejected', 'failed')`,
    ),
    check('documents_source_type_check', sql`${t.sourceType} in ('pdf', 'image', 'xml')`),
    check('documents_content_hash_check', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check('documents_version_check', sql`${t.version} >= 1`),
    check('documents_failure_code_check', sql`${t.failureCode} ~ '^[A-Z][A-Z0-9_]{1,63}$'`),
  ],
);

/**
 * What the AI service extracted from one version of a document (DATA_MODEL.md). Append-only: the
 * app role has no UPDATE/DELETE. At most one row per (document, version): that unique key is what
 * makes the worker idempotent, because a job delivered twice inserts the same row twice and the
 * second insert does nothing. `data` is the Invoice JSON exactly as `InvoiceSchema` validated it.
 * `model`/`prompt_version`/tokens/cost are null on the XML path (no LLM involved).
 */
export const extractions = pgTable(
  'extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    documentVersion: integer('document_version').notNull(),
    // Where the data came from: the deterministic XML parser or the LLM path (same words as documents.source_type).
    source: text('source').notNull(),
    data: jsonb('data').notNull(),
    warnings: jsonb('warnings')
      .notNull()
      .default(sql`'[]'::jsonb`),
    model: text('model'),
    promptVersion: text('prompt_version'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('extractions_document_version_unique').on(t.documentId, t.documentVersion),
    unique('extractions_id_tenant_unique').on(t.id, t.tenantId),
    index('extractions_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    check('extractions_source_check', sql`${t.source} in ('pdf', 'image', 'xml')`),
    check('extractions_document_version_check', sql`${t.documentVersion} >= 1`),
    check('extractions_latency_check', sql`${t.latencyMs} >= 0`),
  ],
);

/**
 * What a person approved (DATA_MODEL.md). Written only by approval, at most one row per document
 * (`UNIQUE (document_id)` is also the last line of defence against a double approval). The columns
 * are what aggregate questions filter on; `data` is the whole approved Invoice incl. `fieldMeta`,
 * validated by `InvoiceSchema`, from which the columns are derived in the same insert. The foreign
 * keys are composite because an ordinary FK check ignores RLS and would accept another tenant's id.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentId: uuid('document_id').notNull(),
    documentVersion: integer('document_version').notNull(),
    invoiceNo: text('invoice_no').notNull(),
    series: text('series').notNull(),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    sellerTaxCode: text('seller_tax_code').notNull(),
    sellerName: text('seller_name').notNull(),
    // Individual buyers have no tax code.
    buyerTaxCode: text('buyer_tax_code'),
    currency: char('currency', { length: 3 }).notNull(),
    // Minor units. `mode: 'number'` is safe: InvoiceSchema only accepts safe integers.
    subtotal: bigint('subtotal', { mode: 'number' }).notNull(),
    vatAmount: bigint('vat_amount', { mode: 'number' }).notNull(),
    total: bigint('total', { mode: 'number' }).notNull(),
    data: jsonb('data').notNull(),
    // The rule warnings at approval: they never block it (PRD 5.4), so keep what was accepted.
    warnings: jsonb('warnings')
      .notNull()
      .default(sql`'[]'::jsonb`),
    // No FK, like `uploaded_by`: users are provisioned lazily.
    approvedBy: uuid('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('invoices_document_unique').on(t.documentId),
    unique('invoices_id_tenant_unique').on(t.id, t.tenantId),
    foreignKey({
      name: 'invoices_document_tenant_fk',
      columns: [t.documentId, t.tenantId],
      foreignColumns: [documents.id, documents.tenantId],
    }),
    index('invoices_tenant_issue_date_idx').on(t.tenantId, t.issueDate),
    index('invoices_tenant_seller_tax_code_idx').on(t.tenantId, t.sellerTaxCode),
    check('invoices_document_version_check', sql`${t.documentVersion} >= 1`),
  ],
);

/** One row per line of an approved invoice. `line_no` is 1-based; its field path is `lines.<line_no - 1>`. */
export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    invoiceId: uuid('invoice_id').notNull(),
    lineNo: integer('line_no').notNull(),
    description: text('description').notNull(),
    // Unconstrained numeric: a fixed scale would silently round what the person approved.
    quantity: numeric('quantity').notNull(),
    unit: text('unit').notNull(),
    unitPrice: bigint('unit_price', { mode: 'number' }).notNull(),
    vatRate: numeric('vat_rate').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
  },
  (t) => [
    unique('invoice_lines_invoice_line_unique').on(t.invoiceId, t.lineNo),
    foreignKey({
      name: 'invoice_lines_invoice_tenant_fk',
      columns: [t.invoiceId, t.tenantId],
      foreignColumns: [invoices.id, invoices.tenantId],
    }),
    check('invoice_lines_line_no_check', sql`${t.lineNo} >= 1`),
  ],
);

/**
 * One row per field the reviewer changed compared with the extraction. Computed by the server, never
 * taken from the client. Values are document content: never log them. A NULL value means the field
 * had no value on that side (`buyer.taxCode`, or a line that was added or removed).
 */
export const fieldCorrections = pgTable(
  'field_corrections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    extractionId: uuid('extraction_id').notNull(),
    // The document version approved: re-approving after a reopen compares with the same extraction.
    documentVersion: integer('document_version').notNull(),
    fieldPath: text('field_path').notNull(),
    aiValue: jsonb('ai_value'),
    humanValue: jsonb('human_value'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('field_corrections_extraction_version_path_unique').on(
      t.extractionId,
      t.documentVersion,
      t.fieldPath,
    ),
    foreignKey({
      name: 'field_corrections_extraction_tenant_fk',
      columns: [t.extractionId, t.tenantId],
      foreignColumns: [extractions.id, extractions.tenantId],
    }),
    index('field_corrections_tenant_path_idx').on(t.tenantId, t.fieldPath),
    check('field_corrections_document_version_check', sql`${t.documentVersion} >= 1`),
  ],
);

/**
 * One row per Idempotency-Key a tenant has used on a create request (API.md: replay for 24 h).
 * Stores a reference, not the response body: a replay is rebuilt from the document. `request_hash`
 * is the sha256 of the uploaded bytes, so the same key with a different file is detectable.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    key: text('key').notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    // The status of the original response (201 created, 200 existing), replayed as-is.
    statusCode: integer('status_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.key] }),
    check('idempotency_keys_request_hash_check', sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
    check('idempotency_keys_status_code_check', sql`${t.statusCode} in (200, 201)`),
  ],
);
