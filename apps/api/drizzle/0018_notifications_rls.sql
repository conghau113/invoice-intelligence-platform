-- notifications: tenant isolation (ADR 0003), same pattern as 0016_chunks_rls.sql. The policy scopes
-- rows to the tenant only; the database does not know the user, so every query also filters on
-- `user_id` (NotificationsRepository, covered by the isolation tests). The app role may only mark a
-- row read: UPDATE is granted on `read_at` alone, so a bug cannot move a notification to another user
-- or document. No DELETE: history stays.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notifications
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON notifications TO invoice_app;
--> statement-breakpoint
GRANT UPDATE (read_at) ON notifications TO invoice_app;
