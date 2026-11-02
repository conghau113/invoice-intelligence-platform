CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version" integer NOT NULL,
	"source" text NOT NULL,
	"data" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"prompt_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extractions_document_version_unique" UNIQUE("document_id","document_version"),
	CONSTRAINT "extractions_source_check" CHECK ("extractions"."source" in ('pdf', 'image', 'xml')),
	CONSTRAINT "extractions_document_version_check" CHECK ("extractions"."document_version" >= 1),
	CONSTRAINT "extractions_latency_check" CHECK ("extractions"."latency_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extractions_tenant_created_idx" ON "extractions" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_failure_code_check" CHECK ("documents"."failure_code" ~ '^[A-Z][A-Z0-9_]{1,63}$');