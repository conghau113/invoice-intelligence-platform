-- documents: tenant isolation (ADR 0003), same pattern as 0001_rls.sql.
-- The app can read, insert, and change only `status` and `version`: content_hash, storage_key,
-- tenant_id and the rest are immutable after insert (idempotency depends on content_hash). No
-- DELETE. `status` is changed only through DocumentStateMachine (a code convention: the machine
-- uses this same role, so the database cannot enforce it).
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON documents
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
-- RESTRICTIVE policies are ANDed with tenant_isolation: a new document can only be born as
-- 'uploaded' version 1, so INSERT cannot skip the state machine (e.g. insert as 'approved').
CREATE POLICY initial_state ON documents AS RESTRICTIVE FOR INSERT
  WITH CHECK (status = 'uploaded' AND version = 1);
--> statement-breakpoint
GRANT SELECT, INSERT ON documents TO invoice_app;
--> statement-breakpoint
GRANT UPDATE (status, version) ON documents TO invoice_app;
