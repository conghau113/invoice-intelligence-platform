import { invoiceFieldPaths, type FieldMeta, type Invoice } from 'contracts';

const keyOf = (meta: FieldMeta): string =>
  JSON.stringify([meta.confidence, meta.evidence?.page ?? null, meta.evidence?.text ?? null]);

/**
 * The `fieldMeta` to store with an approved invoice. The client must send it, because deleting a line
 * moves the meta of later lines up an index and only the form knows which line went. But it describes
 * what the AI found, which a person cannot edit, and `evidence.text` is not shown on the form: a
 * value invented there would be stored unseen and later reach the Q&A prompt (T5.x). So an entry is
 * kept only if the extraction really holds that same meta and its path exists on this invoice.
 */
export function trustedFieldMeta(ai: Invoice, approved: Invoice): Invoice['fieldMeta'] {
  const known = new Set(Object.values<FieldMeta>(ai.fieldMeta).map(keyOf));
  const paths = new Set(invoiceFieldPaths(approved));
  return Object.fromEntries(
    Object.entries<FieldMeta>(approved.fieldMeta).filter(
      ([path, meta]) => paths.has(path) && known.has(keyOf(meta)),
    ),
  );
}
