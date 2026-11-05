import { invoiceFieldPaths, type Invoice } from 'contracts';

export interface FieldCorrection {
  /** Same grammar as `fieldMeta` and rule warnings (`seller.name`, `lines.0.amount`). */
  fieldPath: string;
  /** `null` when that side has no value: `buyer.taxCode`, or a line added or removed. */
  aiValue: string | number | null;
  humanValue: string | number | null;
}

const valueAt = (invoice: Invoice, path: string): string | number | null => {
  let value: unknown = invoice;
  for (const key of path.split('.')) {
    value = (value as Record<string, unknown> | undefined)?.[key];
  }
  return (value ?? null) as string | number | null;
};

/**
 * What the person changed compared with the AI, one entry per field. `fieldMeta` is not compared:
 * it describes the extraction and is not something the person edits. Lines and VAT rows are matched
 * by position, so deleting a line in the middle reports every line after it as changed (Phát sinh
 * T3.5, for the T4.6 metric). Pure, so the API can run it on the stored extraction instead of
 * trusting a diff from the client.
 */
export function diffInvoice(ai: Invoice, human: Invoice): FieldCorrection[] {
  const paths = new Set([...invoiceFieldPaths(ai), ...invoiceFieldPaths(human)]);
  const out: FieldCorrection[] = [];
  for (const fieldPath of paths) {
    const aiValue = valueAt(ai, fieldPath);
    const humanValue = valueAt(human, fieldPath);
    if (aiValue !== humanValue) out.push({ fieldPath, aiValue, humanValue });
  }
  return out;
}
