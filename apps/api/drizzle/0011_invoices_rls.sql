-- invoices, invoice_lines, field_corrections: tenant isolation (ADR 0003), same pattern as
-- 0004_documents_rls.sql. Approval only ever inserts, so the app role gets SELECT and INSERT:
-- what a person approved, and what they changed, cannot be rewritten afterwards.
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON invoices TO invoice_app;
--> statement-breakpoint
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invoice_lines
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON invoice_lines TO invoice_app;
--> statement-breakpoint
ALTER TABLE field_corrections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE field_corrections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON field_corrections
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON field_corrections TO invoice_app;
