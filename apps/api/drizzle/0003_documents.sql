CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"source_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" char(64) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_tenant_hash_unique" UNIQUE("tenant_id","content_hash"),
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('uploaded', 'queued', 'processing', 'needs_review', 'approved', 'rejected', 'failed')),
	CONSTRAINT "documents_source_type_check" CHECK ("documents"."source_type" in ('pdf', 'image', 'xml')),
	CONSTRAINT "documents_content_hash_check" CHECK ("documents"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_version_check" CHECK ("documents"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_tenant_status_created_idx" ON "documents" USING btree ("tenant_id","status","created_at" DESC NULLS LAST);