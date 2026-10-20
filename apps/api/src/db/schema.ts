import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  index,
  inet,
  integer,
  jsonb,
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
    uploadedBy: uuid('uploaded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('documents_tenant_hash_unique').on(t.tenantId, t.contentHash),
    index('documents_tenant_status_created_idx').on(t.tenantId, t.status, t.createdAt.desc()),
    check(
      'documents_status_check',
      sql`${t.status} in ('uploaded', 'queued', 'processing', 'needs_review', 'approved', 'rejected', 'failed')`,
    ),
    check('documents_source_type_check', sql`${t.sourceType} in ('pdf', 'image', 'xml')`),
    check('documents_content_hash_check', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check('documents_version_check', sql`${t.version} >= 1`),
  ],
);
