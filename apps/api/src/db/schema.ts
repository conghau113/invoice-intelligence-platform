import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  inet,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
