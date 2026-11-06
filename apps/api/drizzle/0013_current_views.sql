-- Reopening keeps what was approved (0012), so `invoices` and `field_corrections` are history. These
-- views answer "what counts now". A row is current when its version is the document's version: rows
-- at version N are written only by approving version N, and reopening always bumps the version, so
-- no status check is needed and a reopened document has no current row until it is approved again.
-- security_invoker: the caller's RLS applies to the tables below. By default a view would run with
-- its owner's rights, and tenant isolation would then rest on the owner, not on the caller.
CREATE VIEW current_invoices WITH (security_invoker = true) AS
  SELECT i.*
    FROM invoices i
    JOIN documents d
      ON d.id = i.document_id AND d.tenant_id = i.tenant_id AND d.version = i.document_version;
--> statement-breakpoint
GRANT SELECT ON current_invoices TO invoice_app;
--> statement-breakpoint
-- Each approval diffs the whole invoice against the extraction, so a later version repeats what an
-- earlier one changed. The human correction rate (T4.6) must count one version per document.
CREATE VIEW current_field_corrections WITH (security_invoker = true) AS
  SELECT fc.*, e.document_id
    FROM field_corrections fc
    JOIN extractions e
      ON e.id = fc.extraction_id AND e.tenant_id = fc.tenant_id
    JOIN documents d
      ON d.id = e.document_id AND d.tenant_id = e.tenant_id AND d.version = fc.document_version;
--> statement-breakpoint
GRANT SELECT ON current_field_corrections TO invoice_app;
