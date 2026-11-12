import { fuse, RRF_K, type Ranked } from './rrf';

const list = (...ids: string[]): Ranked<string>[] => ids.map((id) => ({ id, item: id }));

describe('fuse (Reciprocal Rank Fusion)', () => {
  it('scores each item as the sum of 1 / (k + rank) over the lists that return it', () => {
    // b (2nd + 1st) first, then a (1st once) before c (2nd once).
    const [b, a, c] = fuse([list('a', 'b'), list('b', 'c')], 10);
    expect(b).toMatchObject({ id: 'b', ranks: [2, 1] });
    expect(b!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12);
    expect(a).toMatchObject({ id: 'a', ranks: [1, null] });
    expect(a!.score).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(c).toMatchObject({ id: 'c', ranks: [null, 2] });
  });

  it('an item both lists rank fairly high beats one that a single list ranks first', () => {
    // "x" is 1st in vector only; "y" is 3rd in both.
    const fused = fuse([list('x', 'p', 'y'), list('q', 'r', 'y')], 3);
    expect(fused[0]!.id).toBe('y');
  });

  it('uses ranks only: the same order gives the same result whatever the raw scores were', () => {
    const vector: Ranked<{ distance: number }>[] = [
      { id: 'a', item: { distance: 0.01 } },
      { id: 'b', item: { distance: 1.9 } },
    ];
    const tiny: Ranked<{ distance: number }>[] = [
      { id: 'a', item: { distance: 0.5 } },
      { id: 'b', item: { distance: 0.51 } },
    ];
    const other: Ranked<{ distance: number }>[] = [{ id: 'b', item: { distance: 0 } }];
    const ids = (l: Ranked<{ distance: number }>[]) => fuse([l, other], 2).map((f) => f.id);
    expect(ids(vector)).toEqual(ids(tiny));
  });

  it('keeps the first item from each list and breaks ties by id', () => {
    expect(fuse([list('a', 'z'), list('z', 'a')], 2).map((f) => f.id)).toEqual(['a', 'z']);
    // A duplicate in one list does not vote twice.
    const [only] = fuse([list('a', 'a', 'a')], 1);
    expect(only).toMatchObject({ ranks: [1] });
    expect(only!.score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it('cuts to topK and handles empty lists', () => {
    expect(fuse([list('a', 'b', 'c'), []], 2).map((f) => f.id)).toEqual(['a', 'b']);
    expect(fuse([[], []], 5)).toEqual([]);
  });

  it('refuses a top-k or k that cannot work', () => {
    expect(() => fuse([list('a')], 0)).toThrow(RangeError);
    expect(() => fuse([list('a')], 1.5)).toThrow(RangeError);
    expect(() => fuse([list('a')], 1, 0)).toThrow(RangeError);
  });
});
