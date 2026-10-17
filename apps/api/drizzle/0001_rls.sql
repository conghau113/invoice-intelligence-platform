-- Tenant isolation (ADR 0003). Hand-written because Drizzle cannot emit FORCE ROW LEVEL SECURITY.
--
-- Pattern for every new business table (copy this block):
--   1. ALTER TABLE t ENABLE ROW LEVEL SECURITY;  ALTER TABLE t FORCE ROW LEVEL SECURITY;
--   2. CREATE POLICY tenant_isolation ON t USING (tenant_id = app_current_tenant())
--                                         WITH CHECK (tenant_id = app_current_tenant());
--   3. GRANT only the privileges the app needs to invoice_app (no DEFAULT PRIVILEGES: a table
--      whose grant is forgotten fails with "permission denied" instead of being wide open).
-- The catalog test in test/db.int-spec.ts fails if a public table skips step 1 or 2.

-- The application role. NOSUPERUSER/NOBYPASSRLS/not an owner => policies always apply to it.
-- No password here (it would be committed); runMigrations() sets it from APP_DB_PASSWORD.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'invoice_app') THEN
    CREATE ROLE invoice_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO invoice_app;
--> statement-breakpoint

-- Current tenant of this transaction, or NULL. NULLIF matters: after a transaction that used
-- set_config(..., true), a pooled connection returns '' (not NULL) and ''::uuid would raise.
-- NULL makes every policy comparison false => zero rows, never an error and never a leak.
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

-- The one deliberate hole: the auth guard must map the token's organization alias to a tenant id
-- BEFORE any tenant is known, but `tenants` is protected. SECURITY DEFINER runs as the owner and
-- returns a single uuid for an exact alias; search_path is pinned so it cannot be hijacked.
CREATE FUNCTION app_resolve_tenant(p_alias text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT id FROM public.tenants WHERE alias = p_alias $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_tenant(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_tenant(text) TO invoice_app;
--> statement-breakpoint

-- tenants: a request sees only its own tenant row; the app never writes tenants.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT ON tenants TO invoice_app;
--> statement-breakpoint

-- memberships
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO invoice_app;
--> statement-breakpoint

-- audit_logs: append-only, enforced by privileges (no UPDATE/DELETE) on top of RLS.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_logs
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_logs TO invoice_app;
--> statement-breakpoint

-- users: global identity without tenant_id. A request sees (and updates) only users who are
-- members of the current tenant. INSERT is open so a first login can create the row before the
-- membership exists; note INSERT ... RETURNING / ON CONFLICT also need the SELECT policy, so
-- provisioning must insert the membership before reading the user back.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_select ON users FOR SELECT
  USING (EXISTS (SELECT 1 FROM memberships m
                 WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant()));
--> statement-breakpoint
CREATE POLICY users_update ON users FOR UPDATE
  USING (EXISTS (SELECT 1 FROM memberships m
                 WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant()))
  WITH CHECK (EXISTS (SELECT 1 FROM memberships m
                      WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant()));
--> statement-breakpoint
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON users TO invoice_app;
