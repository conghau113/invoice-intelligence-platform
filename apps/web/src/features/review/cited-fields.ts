/** At most this many fields are taken from the URL; a citation link carries fewer (T5.5). */
export const MAX_CITED_FIELDS = 40;

// A form path: `seller.name`, `lines.3.amount`, `vatBreakdown.0.rate`. Anything else is dropped.
const PATH = /^[A-Za-z][A-Za-z0-9]{0,39}(?:\.[A-Za-z0-9]{1,40}){0,3}$/;

/**
 * The `?fields=` of a citation link (Q&A, T5.5) as form paths. The URL is input like any other:
 * only well-formed paths are kept, once each, at most `MAX_CITED_FIELDS`.
 */
export function parseCitedFields(raw: string | string[] | undefined): string[] {
  const text = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  const out = new Set<string>();
  for (const part of text.split(',')) {
    if (out.size >= MAX_CITED_FIELDS) break;
    const path = part.trim();
    if (PATH.test(path)) out.add(path);
  }
  return [...out];
}

/**
 * The cited field whose evidence the viewer should show first: the first one, in citation order,
 * for which the AI recorded where it found the value (XML invoices have none).
 */
export function firstCitedWithEvidence(
  cited: readonly string[],
  fieldMeta: Readonly<Record<string, { evidence?: unknown } | undefined>>,
): string | undefined {
  return cited.find((p) => Object.hasOwn(fieldMeta, p) && fieldMeta[p]?.evidence != null);
}
