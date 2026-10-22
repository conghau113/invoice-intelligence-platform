DROP INDEX "documents_tenant_status_created_idx";--> statement-breakpoint
CREATE INDEX "documents_tenant_created_idx" ON "documents" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "documents_tenant_status_created_idx" ON "documents" USING btree ("tenant_id","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);