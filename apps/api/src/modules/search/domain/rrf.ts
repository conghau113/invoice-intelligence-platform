/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009), used by hybrid retrieval (T5.3).
 *
 * Each list is already sorted best first. An item at 1-based rank r in a list earns 1 / (k + r) from
 * that list; its fused score is the sum over the lists it appears in. Only ranks are used, never the
 * raw scores: a cosine distance (0..2, smaller is better) and a full-text score (a sum of IDF,
 * unbounded, larger is better) are on scales that cannot be added, and either list could dominate
 * if they were. k dampens the head of each list: with k = 60 the 1st and 2nd places differ by about 1.6 %, so
 * an item that both lists rank fairly high beats one that only a single list ranks first.
 */
export const RRF_K = 60;

export type Ranked<T> = { id: string; item: T };

export type Fused<T> = {
  id: string;
  item: T;
  score: number;
  /** 1-based rank of the item in each input list, `null` where the list did not return it. */
  ranks: (number | null)[];
};

export function fuse<T>(
  lists: readonly (readonly Ranked<T>[])[],
  topK: number,
  k = RRF_K,
): Fused<T>[] {
  if (!Number.isInteger(topK) || topK < 1) throw new RangeError('topK must be a positive integer');
  if (!(k > 0)) throw new RangeError('k must be positive');
  const byId = new Map<string, Fused<T>>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    list.forEach(({ id, item }, index) => {
      // A list must not vote twice for the same item (a join gone wrong would do that).
      if (seen.has(id)) return;
      seen.add(id);
      let entry = byId.get(id);
      if (entry === undefined) {
        entry = { id, item, score: 0, ranks: lists.map(() => null) };
        byId.set(id, entry);
      }
      entry.ranks[li] = index + 1;
      entry.score += 1 / (k + index + 1);
    });
  });
  // Ties (same ranks in mirrored lists) are broken by id, so the same input always gives the same order.
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, topK);
}
