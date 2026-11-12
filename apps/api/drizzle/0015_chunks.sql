-- pgvector (ADR 0011). The init scripts create it (dev: scripts/postgres-init, prod: infra/prod/postgres-init,
-- as superuser); IF NOT EXISTS makes this a no-op there and creates it where the owner may (tests).
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version" integer NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"content_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED NOT NULL,
	"embedding" vector(768) NOT NULL,
	"embedding_model" text NOT NULL,
	"refs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_document_version_ordinal_unique" UNIQUE("document_id","document_version","ordinal"),
	CONSTRAINT "chunks_kind_check" CHECK ("chunks"."kind" in ('header', 'lines')),
	CONSTRAINT "chunks_ordinal_check" CHECK ("chunks"."ordinal" >= 0),
	CONSTRAINT "chunks_document_version_check" CHECK ("chunks"."document_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_invoice_tenant_fk" FOREIGN KEY ("invoice_id","tenant_id") REFERENCES "public"."invoices"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_tenant_fk" FOREIGN KEY ("document_id","tenant_id") REFERENCES "public"."documents"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_tenant_document_idx" ON "chunks" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chunks_content_tsv_idx" ON "chunks" USING gin ("content_tsv");