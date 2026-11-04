export interface TextRange {
  /** Index of the first/last text item and the offset inside it. `end` is exclusive. */
  start: { item: number; offset: number };
  end: { item: number; offset: number };
}

const NO_SPACE = /\s/;

/**
 * Finds `needle` (the AI's evidence excerpt) in the text of a page, which pdf.js delivers as many
 * small items. ALL whitespace is ignored on both sides: whether two items are joined by a space,
 * nothing or a line break differs between PDFs and between the excerpt and the page. Case is not
 * ignored. Returns the item/offset range to highlight (end exclusive), or null.
 */
export function findEvidence(items: readonly string[], needle: string): TextRange | null {
  const wanted = needle.replace(/\s+/g, '');
  if (wanted === '') return null;

  // One string for the page without whitespace, remembering which item each character came from.
  let page = '';
  const origin: { item: number; offset: number }[] = [];
  items.forEach((text, item) => {
    // UTF-16 units, not code points: the offsets are used with String.slice / DOM text offsets.
    for (let offset = 0; offset < text.length; offset++) {
      const ch = text.charAt(offset);
      if (NO_SPACE.test(ch)) continue;
      page += ch;
      origin.push({ item, offset });
    }
  });

  const at = page.indexOf(wanted);
  if (at < 0) return null;
  const first = origin[at]!;
  const last = origin[at + wanted.length - 1]!;
  return { start: first, end: { item: last.item, offset: last.offset + 1 } };
}

/** For a plain-text view (XML): the same search on one string. */
export function findInText(text: string, needle: string): { start: number; end: number } | null {
  const r = findEvidence([text], needle);
  return r === null ? null : { start: r.start.offset, end: r.end.offset };
}
