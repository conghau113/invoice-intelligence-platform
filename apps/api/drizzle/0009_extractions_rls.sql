-- extractions: tenant isolation (ADR 0003), same pattern as 0004_documents_rls.sql.
-- Append-only: the app can read and insert, never update or delete, so an extraction cannot be
-- rewritten after the fact (human edits go to field_corrections / invoices, M3).
-- Also: documents.failure_code is written together with `status` by DocumentStateMachine.
ALTER TABLE extractions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE extractions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON extractions
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON extractions TO invoice_app;
--> statement-breakpoint
GRANT UPDATE (failure_code) ON documents TO invoice_app;
