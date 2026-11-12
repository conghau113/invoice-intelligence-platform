/**
 * Citation check of a lookup answer (T5.4, AI_PIPELINE.md §7). The model cites the n-th source it was
 * given as `[n]`; it never sees a chunk id, so it cannot write one. An answer is accepted only when
 * it cites at least one source and every source it cites is one of the chunks retrieved for THIS
 * question. Pure function: the caller maps the numbers back to chunks.
 */

export type CitationCheck =
  | { ok: true; cited: number[] }
  | { ok: false; problem: 'NO_CITATION' | 'UNKNOWN_SOURCE' | 'MALFORMED_CITATION' };

/**
 * Any bracketed text on one line, with no `[` inside: otherwise "[ghi chú [1]" would be read as one
 * bracket and hide the marker. One negated class that cannot contain its own end: linear, no
 * backtracking. No length bound: a bound let "[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]" (31 characters)
 * pass as plain text (code review). The content decides what it is (below).
 */
const BRACKET = /\[([^[\]\n]*)\]/g;
/** Exactly `[n]`, no spaces: so the marker is one token of the stream and the web can find it. */
const SINGLE = /^\d+$/;
/**
 * Digits with spaces or separators: "[1, 3]", "[2-4]", "[ 1 ]". A citation, but not one we accept:
 * refused rather than parsed, as "[1-9]" could hide a source that was never retrieved.
 */
const LIST = /^[\d\s,;-]+$/;

export function checkCitations(answer: string, sourceCount: number): CitationCheck {
  const cited: number[] = [];
  for (const [, inner] of answer.matchAll(BRACKET)) {
    const text = inner!;
    if (SINGLE.test(text)) {
      const n = Number(text);
      if (!Number.isSafeInteger(n) || n < 1 || n > sourceCount) {
        return { ok: false, problem: 'UNKNOWN_SOURCE' };
      }
      if (!cited.includes(n)) cited.push(n);
    } else if (LIST.test(text) && /\d/.test(text)) {
      return { ok: false, problem: 'MALFORMED_CITATION' };
    }
    // Anything else ("[SAMPLE]", "[sic]") is text from an invoice, not a citation.
  }
  if (cited.length === 0) return { ok: false, problem: 'NO_CITATION' };
  return { ok: true, cited };
}
