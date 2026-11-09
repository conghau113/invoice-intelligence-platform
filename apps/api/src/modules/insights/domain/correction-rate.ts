import { HEADER_FIELD_PATHS, LINE_COLUMNS, VAT_COLUMNS, type CorrectedField } from 'contracts';

/** How many documents changed one (grouped) field in their approved version. */
export interface FieldCount {
  field: string;
  documents: number;
}

/** Every field the page shows, in form order, so a field nobody corrected still appears at 0 %. */
export const REPORTED_FIELDS: readonly string[] = [
  ...HEADER_FIELD_PATHS,
  ...LINE_COLUMNS.map((c) => `lines.*.${c}`),
  ...VAT_COLUMNS.map((c) => `vatBreakdown.*.${c}`),
];

/**
 * The human correction rate per field: documents whose approved version changed that field, over
 * `approvedDocuments`. Line and VAT columns arrive grouped (`lines.*.amount`) and count documents
 * with at least one changed cell, not cells: rows are compared by position (T3.5), so one deleted
 * line would otherwise count every line after it. The counts must come from current rows only
 * (`current_field_corrections`), or every re-approval counts the same change again.
 */
export function correctionRate(
  approvedDocuments: number,
  counts: readonly FieldCount[],
): CorrectedField[] {
  const byField = new Map(counts.map((c) => [c.field, c.documents]));
  // A path outside the known list (a schema field added later) is shown after the known ones
  // rather than dropped.
  const extra = counts
    .map((c) => c.field)
    .filter((f) => !REPORTED_FIELDS.includes(f))
    .sort();
  return [...REPORTED_FIELDS, ...extra].map((field) => {
    const documents = byField.get(field) ?? 0;
    return { field, documents, rate: approvedDocuments === 0 ? 0 : documents / approvedDocuments };
  });
}
