-- `invoice_lines` is history too: the lines of every approved version stay, and the table has no
-- version column of its own. Aggregates and chunking read the lines of the current invoice from here.
CREATE VIEW current_invoice_lines WITH (security_invoker = true) AS
  SELECT l.*, i.document_id
    FROM invoice_lines l
    JOIN current_invoices i
      ON i.id = l.invoice_id AND i.tenant_id = l.tenant_id;
--> statement-breakpoint
GRANT SELECT ON current_invoice_lines TO invoice_app;
