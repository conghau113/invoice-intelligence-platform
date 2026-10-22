export type PageItem = number | 'gap';

/**
 * The page buttons to show: always the first and last page, the current one with `siblings` on
 * each side, and a 'gap' (an ellipsis) wherever pages are left out. A gap that would hide a single
 * page shows that page instead (an ellipsis for one number saves nothing).
 */
export function pageWindow(page: number, totalPages: number, siblings = 1): PageItem[] {
  if (totalPages < 1) return [];
  const current = Math.min(Math.max(page, 1), totalPages);
  const wanted = new Set<number>([1, totalPages]);
  for (let p = current - siblings; p <= current + siblings; p++) {
    if (p >= 1 && p <= totalPages) wanted.add(p);
  }
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: PageItem[] = [];
  let previous = 0;
  for (const p of sorted) {
    if (p - previous === 2) out.push(previous + 1);
    else if (p - previous > 2) out.push('gap');
    out.push(p);
    previous = p;
  }
  return out;
}

/** The 1-based position of the first and last row on this page, for "21–40 of 142". */
export function pageRange(
  page: number,
  pageSize: number,
  total: number,
): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 };
  // A page past the end (a hand-typed URL, before the screen moves to the last page) shows the
  // last page's range, never "from 199961 to 5".
  const current = clampPage(page, Math.ceil(total / pageSize));
  const from = (current - 1) * pageSize + 1;
  return { from, to: Math.min(current * pageSize, total) };
}

/** What to do with a page number the list no longer has (rows were removed, a filter narrowed). */
export function clampPage(page: number, totalPages: number): number {
  if (totalPages < 1) return 1;
  return Math.min(Math.max(page, 1), totalPages);
}
