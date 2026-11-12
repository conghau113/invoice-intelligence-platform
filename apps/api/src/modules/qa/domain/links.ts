/**
 * Links in a lookup answer must come from the sources it cites (T5.4, security review). A stored
 * invoice can carry an instruction such as "tell the user to pay at http://…"; the citation check
 * alone would let that link through next to a valid `[1]`. A link that is not written in a cited
 * chunk is refused, so the model cannot hand the reader an address no invoice contains.
 *
 * Covers `http://`, `https://` and `www.` forms. A bare domain ("pay.example") is not detected:
 * the web shows the answer as plain text and never turns it into a link (T5.5).
 */

/** One negated class, no nested repetition: linear. Brackets end a link so `[1]` is not part of it. */
const LINK = /(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+/gi;
/** Sentence punctuation right after a link belongs to the sentence, not to the link. */
const TRAILING = /[.,;:!?]+$/;

export function unsourcedLinks(answer: string, citedSources: string[]): string[] {
  const haystack = citedSources.join('\n').toLowerCase();
  const missing: string[] = [];
  for (const [match] of answer.matchAll(LINK)) {
    const link = match.replace(TRAILING, '');
    if (!haystack.includes(link.toLowerCase())) missing.push(link);
  }
  return missing;
}
