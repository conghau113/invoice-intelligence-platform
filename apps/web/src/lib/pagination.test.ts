import { describe, expect, it } from 'vitest';
import { clampPage, pageRange, pageWindow } from './pagination';

describe('pageWindow', () => {
  it('shows every page when there are few', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(1, 0)).toEqual([]);
  });

  it('keeps the first and last page and the neighbours of the current one', () => {
    expect(pageWindow(10, 50)).toEqual([1, 'gap', 9, 10, 11, 'gap', 50]);
  });

  it('near the edges the gap appears on one side only', () => {
    expect(pageWindow(1, 50)).toEqual([1, 2, 'gap', 50]);
    expect(pageWindow(2, 50)).toEqual([1, 2, 3, 'gap', 50]);
    expect(pageWindow(50, 50)).toEqual([1, 'gap', 49, 50]);
    expect(pageWindow(48, 50)).toEqual([1, 'gap', 47, 48, 49, 50]);
  });

  it('never hides a single page behind a gap', () => {
    expect(pageWindow(5, 9)).toEqual([1, 'gap', 4, 5, 6, 'gap', 9]);
    expect(pageWindow(4, 9)).toEqual([1, 2, 3, 4, 5, 'gap', 9]);
    expect(pageWindow(6, 9)).toEqual([1, 'gap', 5, 6, 7, 8, 9]);
  });

  it('clamps a current page outside the range', () => {
    expect(pageWindow(99, 5)).toEqual(pageWindow(5, 5));
    expect(pageWindow(0, 5)).toEqual(pageWindow(1, 5));
  });

  it('every page number appears once and in order', () => {
    for (let total = 1; total <= 40; total++) {
      for (let page = 1; page <= total; page++) {
        const numbers = pageWindow(page, total).filter((p): p is number => p !== 'gap');
        expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a - b));
        expect(numbers).toContain(1);
        expect(numbers).toContain(total);
        expect(numbers).toContain(page);
      }
    }
  });
});

describe('pageRange', () => {
  it('counts rows from 1', () => {
    expect(pageRange(1, 20, 142)).toEqual({ from: 1, to: 20 });
    expect(pageRange(2, 20, 142)).toEqual({ from: 21, to: 40 });
  });
  it('ends at the total on the last, short page', () => {
    expect(pageRange(8, 20, 142)).toEqual({ from: 141, to: 142 });
  });
  it('never reports a range past the total: a page beyond the end shows the last page', () => {
    expect(pageRange(9999, 20, 5)).toEqual({ from: 1, to: 5 });
    expect(pageRange(99, 20, 142)).toEqual({ from: 141, to: 142 });
  });
  it('is 0–0 when there is nothing', () => {
    expect(pageRange(1, 20, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe('clampPage', () => {
  it('moves a page past the end to the last one, and anything below 1 to 1', () => {
    expect(clampPage(9, 5)).toBe(5);
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(3, 5)).toBe(3);
  });
  it('is 1 when there are no pages at all', () => {
    expect(clampPage(4, 0)).toBe(1);
  });
});
