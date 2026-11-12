import type { QaCitation } from 'contracts';
// The page that reads the link owns the limit, so writer and reader cannot drift apart.
import { MAX_CITED_FIELDS } from '@/features/review/cited-fields';

/**
 * A piece of the answer: plain text, or a `[n]` marker with the source it names (null if none).
 * `start` is its offset in the text: stable while the text grows, so it can be a React key.
 */
export type AnswerSegment =
  | { kind: 'text'; start: number; text: string }
  | { kind: 'cite'; start: number; n: number; citation: QaCitation | null };

// Exactly what the API accepts as a citation (T5.4: `[n]`, no spaces, no lists). No nested
// quantifier, so the scan is linear.
const MARKER = /\[(\d{1,4})\]/g;

/**
 * Splits model-written text into plain text and citation markers. The text is never parsed as
 * markdown or HTML and URLs stay text (security review of T5.4): the only structure we give it is
 * the markers. While the citations have not arrived (`null`) a marker has no source yet.
 */
export function answerSegments(text: string, citations: QaCitation[] | null): AnswerSegment[] {
  const byN = new Map((citations ?? []).map((c) => [c.n, c]));
  const out: AnswerSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    if (m.index > last) out.push({ kind: 'text', start: last, text: text.slice(last, m.index) });
    const n = Number(m[1]);
    out.push({ kind: 'cite', start: m.index, n, citation: byN.get(n) ?? null });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', start: last, text: text.slice(last) });
  return out;
}

/**
 * Where a citation opens: the document's review page, with the cited fields in `?fields=` so the
 * page can mark them and jump to the first. Paths are the form's own names (`seller.name`,
 * `lines.0.amount`), the same ones the chunk refs carry (T5.1).
 */
export function citationHref(c: QaCitation): string {
  const paths = [...new Set(c.refs.map((r) => r.field_path))].slice(0, MAX_CITED_FIELDS);
  const query = paths.length > 0 ? `?fields=${encodeURIComponent(paths.join(','))}` : '';
  return `/documents/${c.documentId}${query}`;
}
