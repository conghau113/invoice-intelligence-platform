-- Moved up by hand: the composite foreign keys below need these two constraints to exist first.
ALTER TABLE "documents" ADD CONSTRAINT "documents_id_tenant_unique" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_id_tenant_unique" UNIQUE("id","tenant_id");--> statement-breakpoint
CREATE TABLE "field_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"document_version" integer NOT NULL,
	"field_path" text NOT NULL,
	"ai_value" jsonb,
	"human_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_corrections_extraction_version_path_unique" UNIQUE("extraction_id","document_version","field_path"),
	CONSTRAINT "field_corrections_document_version_check" CHECK ("field_corrections"."document_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric NOT NULL,
	"unit" text NOT NULL,
	"unit_price" bigint NOT NULL,
	"vat_rate" numeric NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "invoice_lines_invoice_line_unique" UNIQUE("invoice_id","line_no"),
	CONSTRAINT "invoice_lines_line_no_check" CHECK ("invoice_lines"."line_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version" integer NOT NULL,
	"invoice_no" text NOT NULL,
	"series" text NOT NULL,
	"issue_date" date NOT NULL,
	"seller_tax_code" text NOT NULL,
	"seller_name" text NOT NULL,
	"buyer_tax_code" text,
	"currency" char(3) NOT NULL,
	"subtotal" bigint NOT NULL,
	"vat_amount" bigint NOT NULL,
	"total" bigint NOT NULL,
	"data" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_document_unique" UNIQUE("document_id"),
	CONSTRAINT "invoices_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "invoices_document_version_check" CHECK ("invoices"."document_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "field_corrections" ADD CONSTRAINT "field_corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_corrections" ADD CONSTRAINT "field_corrections_extraction_tenant_fk" FOREIGN KEY ("extraction_id","tenant_id") REFERENCES "public"."extractions"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_tenant_fk" FOREIGN KEY ("invoice_id","tenant_id") REFERENCES "public"."invoices"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_document_tenant_fk" FOREIGN KEY ("document_id","tenant_id") REFERENCES "public"."documents"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "field_corrections_tenant_path_idx" ON "field_corrections" USING btree ("tenant_id","field_path");--> statement-breakpoint
CREATE INDEX "invoices_tenant_issue_date_idx" ON "invoices" USING btree ("tenant_id","issue_date");--> statement-breakpoint
CREATE INDEX "invoices_tenant_seller_tax_code_idx" ON "invoices" USING btree ("tenant_id","seller_tax_code");
