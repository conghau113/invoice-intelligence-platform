-- chunks: tenant isolation (ADR 0003), same pattern as 0011_invoices_rls.sql. RLS applies to vector
-- and full-text search alike (ADR 0011). Chunks are derived from `current_invoices` and rebuilt at
-- will, so unlike `invoices` the app role may DELETE: reopening removes a document's chunks in the
-- same transaction (T3.8, T5.2), and re-indexing replaces them. No UPDATE: a chunk is replaced, never edited.
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE chunks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON chunks
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON chunks TO invoice_app;
