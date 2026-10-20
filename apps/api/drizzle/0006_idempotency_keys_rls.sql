-- idempotency_keys: tenant isolation (ADR 0003), same pattern as 0004_documents_rls.sql.
-- The app can read, insert and delete, but never update: a key stays bound to its first request.
-- DELETE exists only so a key older than 24 h can be replaced by a new request (API.md); the
-- application deletes only expired rows. Bulk cleanup is an operations job (M7/M8).
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON idempotency_keys TO invoice_app;
